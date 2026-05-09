// uWebSockets bench server.
//
// Modes (env WORKLOAD): echo | hash | fanout | forward
// Port: 8080 (env PORT to override)
//
// Fanout/forward use manual iteration over a peer set so the workload is
// apples-to-apples with the Zig impl (per-peer dedup in forward mode).

#include "App.h"
#include <openssl/evp.h>
#include <cstdlib>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <string>
#include <string_view>
#include <unordered_set>
#include <array>
#include <vector>
#include <memory>

enum class Mode { Echo, Hash, Fanout, Forward };

static Mode parseMode(const char *s) {
    if (!s) return Mode::Echo;
    std::string_view v{s};
    if (v == "echo") return Mode::Echo;
    if (v == "hash") return Mode::Hash;
    if (v == "fanout") return Mode::Fanout;
    if (v == "forward") return Mode::Forward;
    std::cerr << "invalid WORKLOAD: " << v << "\n";
    std::exit(2);
}

static size_t g_seen_cap = 1'000'000;

struct Digest {
    uint8_t b[32];
    bool operator==(const Digest &o) const {
        return std::memcmp(b, o.b, 32) == 0;
    }
};

struct DigestHasher {
    size_t operator()(const Digest &d) const {
        size_t h;
        std::memcpy(&h, d.b, sizeof(h));
        return h;
    }
};

struct PerSocketData {
    // Heap-allocated ring buffer; sized to g_seen_cap.
    std::vector<Digest> ring;
    size_t head = 0;
    size_t len = 0;
    std::unordered_set<Digest, DigestHasher> set;

    void initSeen() {
        ring.resize(g_seen_cap);
        set.reserve(g_seen_cap);
    }

    bool hasSeen(const Digest &d) const {
        return set.find(d) != set.end();
    }

    void recordSeen(const Digest &d) {
        if (len == ring.size()) {
            set.erase(ring[head]);
        }
        ring[head] = d;
        head = (head + 1) % ring.size();
        if (len < ring.size()) len++;
        set.insert(d);
    }
};

using WsT = uWS::WebSocket<false, true, PerSocketData>;

static std::vector<WsT *> g_peers;

static thread_local EVP_MD_CTX *tl_md_ctx = nullptr;
static const EVP_MD *g_sha3 = nullptr;

static inline void sha3_256(std::string_view data, Digest &out) {
    if (!tl_md_ctx) tl_md_ctx = EVP_MD_CTX_new();
    EVP_DigestInit_ex(tl_md_ctx, g_sha3, nullptr);
    EVP_DigestUpdate(tl_md_ctx, data.data(), data.size());
    unsigned int len = 32;
    EVP_DigestFinal_ex(tl_md_ctx, out.b, &len);
}

int main() {
    Mode mode = parseMode(std::getenv("WORKLOAD"));
    int port = 8080;
    if (const char *p = std::getenv("PORT")) port = std::atoi(p);
    if (const char *s = std::getenv("SEEN_CAP")) g_seen_cap = std::strtoul(s, nullptr, 10);

    g_sha3 = EVP_sha3_256();

    uWS::App app;

    app.ws<PerSocketData>("/*", {
        .compression = uWS::DISABLED,
        .maxPayloadLength = 1 * 1024 * 1024,
        .idleTimeout = 60,
        .maxBackpressure = 16 * 1024 * 1024,
        .closeOnBackpressureLimit = false,
        .resetIdleTimeoutOnSend = false,
        .sendPingsAutomatically = false,

        .upgrade = nullptr,
        .open = [&](auto *ws) {
            ws->getUserData()->initSeen();
            g_peers.push_back(ws);
        },
        .message = [&](auto *ws, std::string_view msg, uWS::OpCode op) {
            switch (mode) {
                case Mode::Echo: {
                    ws->send(msg, op, false);
                    break;
                }
                case Mode::Hash: {
                    Digest d;
                    sha3_256(msg, d);
                    asm volatile("" : : "r"(d.b) : "memory");
                    ws->send(msg, op, false);
                    break;
                }
                case Mode::Fanout: {
                    for (auto *peer : g_peers) {
                        if (peer == ws) continue;
                        peer->send(msg, op, false);
                    }
                    break;
                }
                case Mode::Forward: {
                    Digest d;
                    sha3_256(msg, d);
                    PerSocketData *self = ws->getUserData();
                    self->recordSeen(d);
                    for (auto *peer : g_peers) {
                        if (peer == ws) continue;
                        PerSocketData *psd = peer->getUserData();
                        if (psd->hasSeen(d)) continue;
                        peer->send(msg, op, false);
                        psd->recordSeen(d);
                    }
                    break;
                }
            }
        },
        .close = [&](auto *ws, int /*code*/, std::string_view /*msg*/) {
            auto it = std::find(g_peers.begin(), g_peers.end(), ws);
            if (it != g_peers.end()) g_peers.erase(it);
        },
    }).listen(port, [port, mode](auto *socket) {
        const char *m = "echo";
        switch (mode) {
            case Mode::Echo: m = "echo"; break;
            case Mode::Hash: m = "hash"; break;
            case Mode::Fanout: m = "fanout"; break;
            case Mode::Forward: m = "forward"; break;
        }
        if (socket) {
            std::cout << "cpp-server mode=" << m << " port=" << port << " seen_cap=" << g_seen_cap << std::endl;
        } else {
            std::cerr << "failed to listen on port " << port << std::endl;
            std::exit(1);
        }
    }).run();

    return 0;
}
