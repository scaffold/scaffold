# Hints

Hints are an advanced feature that enable some system-level contracts, like the
data contract and input fetching on blocks. However, you can also use it in your
contracts!

Hints enable contracts to ask for additional data before determining the
validity of a block. For example, consider a hash specified on the block.
Without the plaintext, it is impossible to know whether the hash refers to
another valid block, random data, or even is simply 32 random bytes itself. It
is impossible to litigate whether the block is valid, or even invalid, because
the author may be withholding the data maliciously.
