#pragma once

#include <stdio.h>
#include <unistd.h>

bool read_all(int fd, char *data, size_t &size) {
    size_t pos = 0;
    do {
        ssize_t count = read(fd, data + pos, size - pos);
        if (count == 0) {
            break;
        } else if (count < 0) {
            perror("read() failed");
            return false;
        } else {
            pos += count;
        }
    } while (pos < size);

    size = pos;
    return true;
}

bool write_all(int fd, const char *data, size_t size) {
    size_t written = 0;
    do {
        ssize_t ret = write(fd, data + written, size - written);
        if (ret < 0) {
            perror("Write failed");
            return false;
        } else {
            written += ret;
        }
    } while (written < size);

    return true;
}
