export const chunkText = (input: string, maxLength: number): string[] => {
  if (input.length <= maxLength) {
    return [input];
  }

  const chunks: string[] = [];
  let remaining = input;

  while (remaining.length > maxLength) {
    const slice = remaining.slice(0, maxLength);
    const lastNewline = slice.lastIndexOf("\n");
    const lastSpace = slice.lastIndexOf(" ");
    const splitIndex =
      lastNewline > Math.floor(maxLength * 0.6)
        ? lastNewline + 1
        : lastSpace > Math.floor(maxLength * 0.6)
          ? lastSpace + 1
          : maxLength;

    chunks.push(remaining.slice(0, splitIndex).trimEnd());
    remaining = remaining.slice(splitIndex).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
};
