// ANSI escape: CSI sequences (\x1b[...X), OSC sequences (\x1b]...ST), and simple two-char escapes
const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /[\x1b\x9b][[\]()#;?]*(?:(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]|\x1b\].*?(?:\x07|\x1b\\))/g;

/** Remove ANSI escape sequences (CSI, OSC, etc.) */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

// Control chars except \t (0x09) and \n (0x0a)
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/g;

// Unicode format chars (category Cf) — zero-width joiners, bidi overrides, etc.
const FORMAT_CHARS_RE = /[\u200B-\u200F\u2028-\u202F\uFEFF\uFFF9-\uFFFB]/g;

// Lone surrogates (invalid in well-formed strings but can appear in buffers)
const LONE_SURROGATES_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Sanitize command output for safe LLM consumption:
 * - Strip ANSI escapes
 * - Remove control chars (keep \t, \n)
 * - Remove Unicode format chars and lone surrogates
 * - Normalize \r\n → \n
 */
export function sanitizeOutput(text: string): string {
  let out = stripAnsi(text);
  out = out.replace(/\r\n/g, "\n");
  out = out.replace(/\r/g, "\n");
  out = out.replace(CONTROL_RE, "");
  out = out.replace(FORMAT_CHARS_RE, "");
  out = out.replace(LONE_SURROGATES_RE, "");
  return out;
}
