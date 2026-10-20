// Transport-level .pcpub body cap (ADR-0014 §8). The application limits in
// @pcms/publication stay authoritative; this constant only bounds the HTTP
// parser/route so a hostile upload dies at the socket boundary.
export const API_BODY_LIMIT_PCPUB = 256 * 1_048_576;
