UWS_DIR  := ../uWebSockets
USOCKETS := $(UWS_DIR)/uSockets
OPENSSL  := /opt/homebrew/opt/openssl@3

CXX      ?= clang++
CXXFLAGS := -std=c++20 -O3 -flto -DNDEBUG -fno-omit-frame-pointer
CXXFLAGS += -I$(UWS_DIR)/src -I$(USOCKETS)/src -I$(OPENSSL)/include
CXXFLAGS += -DUWS_NO_ZLIB
LDFLAGS  := $(USOCKETS)/uSockets.a -L$(OPENSSL)/lib -lcrypto -lz

cpp-server: server.cpp $(USOCKETS)/uSockets.a
	$(CXX) $(CXXFLAGS) server.cpp -o $@ $(LDFLAGS)

clean:
	rm -f cpp-server

.PHONY: clean
