#ifdef __cplusplus
extern "C" {
#endif

typedef std::pair<std::uint8_t *, unsigned int> Vector;

// Imports
void version_0_0_1();
void init(unsigned int dstHdl, unsigned int type);
void request(unsigned int dstHdl, unsigned int srcHdl, std::uint8_t *params, unsigned int paramsLen, std::uint64_t amount);
unsigned int read(Vector *dstBufs, unsigned int dstBufsLen, unsigned int srcHdl, std::uint64_t offset);
unsigned int copy(std::uint8_t *dstBuf, unsigned int srcHdl, std::uint8_t *srcBuf, std::uint64_t size);
std::uint64_t size(unsigned int srcHdl);
void run(unsigned int dstHdl, unsigned int srcHdl, Vector *linkInboundImportNames, Vector *linkInboundExportNames, unsigned int numInboundLinks, Vector *linkOutboundExportNames, Vector *linkOutboundImportNames, unsigned int numOutboundLinks);
void debug(unsigned int level, std::uint8_t *params, unsigned int paramsLen);

// Exports
std::uint8_t *alloc(unsigned int size);
bool verify(std::uint8_t *contractHash, std::uint8_t *params, unsigned int paramsLen, std::uint8_t *candidate, unsigned int candidateLen, std::uint8_t *hint, unsigned int hintLen) {}
Vector *generate(std::uint8_t *contractHash, std::uint8_t *params, unsigned int paramsLen, bool emitCorrect, std::uint8_t *user, unsigned int userLen) {}

#ifdef __cplusplus
}
#endif
