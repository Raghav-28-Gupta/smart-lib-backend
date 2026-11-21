/** Makes `%`, `_` and the escape character itself match as plain text in LIKE/ILIKE (use with ESCAPE '\'). */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, '\\$&')
}
