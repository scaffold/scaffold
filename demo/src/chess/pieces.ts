// Unicode chess piece glyphs, indexed by piece code from ChessRules.
// White is uppercase Unicode (0x2654..0x2659); black is lowercase (0x265A..0x265F).
// Convention from ChessRules:
//   1 W_PAWN, 2 W_KNIGHT, 3 W_BISHOP, 4 W_ROOK, 5 W_QUEEN, 6 W_KING
//   7 B_PAWN, 8 B_KNIGHT, 9 B_BISHOP, 10 B_ROOK, 11 B_QUEEN, 12 B_KING

export const PIECE_GLYPHS: Record<number, string> = {
  0: '',
  1: '♙', // white pawn
  2: '♘', // white knight
  3: '♗', // white bishop
  4: '♖', // white rook
  5: '♕', // white queen
  6: '♔', // white king
  7: '♟', // black pawn
  8: '♞', // black knight
  9: '♝', // black bishop
  10: '♜', // black rook
  11: '♛', // black queen
  12: '♚', // black king
};
