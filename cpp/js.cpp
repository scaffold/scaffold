#include <stdio.h>
#include <unistd.h>
#include <fcntl.h>
#include <string>
// #include <iostream>

#include "io.h"

#ifdef __cplusplus
extern "C" {
#endif

int main(int argc, char** argv);

#ifdef __cplusplus
}
#endif

int main(int argc, char** argv) {
    if (argc != 3) {
        const char msg[] = "Usage: eq [path A] [path B]";
        write_all(STDERR_FILENO, msg, sizeof(msg));
        return 1;
    }

    // int fdA = open(argv[1], O_RDONLY);
    // int fdB = open(argv[2], O_RDONLY);
    // freopen(NULL, "wb", stdout);

    write_all(STDOUT_FILENO, "abc\n", 4);
    // std::cout << "def" << std::endl;

    return 0;
}

std::vector<std::string> getPreferredPrecedingParams(std::string params);
std::vector<std::string> getPreferredFollowingParams(std::string params);
