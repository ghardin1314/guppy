/**
 * Insert `code` on the line before the `// @guppy:{marker}` comment.
 * The marker stays in place as a sentinel for future insertions.
 */
export function insertAtMarker(
  content: string,
  marker: string,
  code: string,
): string {
  const tag = `// @guppy:${marker}`;
  const idx = content.indexOf(tag);
  if (idx === -1) {
    throw new Error(`Marker "${tag}" not found in file`);
  }

  // Find the start of the line containing the marker
  const lineStart = content.lastIndexOf("\n", idx - 1) + 1;
  // Preserve the indentation-whitespace before the marker
  const indent = content.slice(lineStart, idx).match(/^(\s*)/)?.[1] ?? "";

  // Insert the code block just before the marker line
  const insertion = code
    .split("\n")
    .join("\n")
    .concat("\n");

  return content.slice(0, lineStart) + insertion + content.slice(lineStart);
}
