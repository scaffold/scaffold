#include <cstdint>
#include <utility>

#ifdef __cplusplus
extern "C" {
#endif

typedef unsigned int BlobHandle;
typedef unsigned int ProcessHandle;
typedef std::pair<std::uint8_t *, unsigned int> Vector;
typedef std::pair<std::uint8_t *, std::uint64_t> OutputTx;

// Imports
void version_0_0_1();

std::uint8_t *getContractHash();
Vector *getParams();
Vector *getCandidate();
Vector *getHint();
Vector *getUserData();
bool getEmitCorrect();

BlobHandle open(std::uint8_t *contractHash, std::uint8_t *params, std::size_t paramsLen);
unsigned int read(Vector *dstBufs, unsigned int dstBufsLen, BlobHandle srcHdl, std::uint64_t offset);
void hash(std::uint8_t *dstHash, BlobHandle srcHdl);
std::uint64_t size(BlobHandle srcHdl);

ProcessHandle selfHandle();
ProcessHandle run(BlobHandle srcHdl, Vector *linkInboundImportNames, Vector *linkInboundExportNames, unsigned int numInboundLinks, Vector *linkOutboundExportNames, Vector *linkOutboundImportNames, unsigned int numOutboundLinks);
void copy(ProcessHandle dstHdl, std::uint8_t *dstBuf, ProcessHandle srcHdl, std::uint8_t *srcBuf, std::uint64_t size);
void debug(unsigned int level, std::uint8_t *buf, unsigned int bufLen);

// Exports
// std::uint8_t *alloc(unsigned int size) { return new uint8_t[size]; }
// void free(std::uint8_t *buf) { delete[] buf; }

bool verify() { return true; }
Vector *generate() {}
std::pair<OutputTx *, unsigned int> *computeOutputTxs() {}

#ifdef __cplusplus
}
#endif
