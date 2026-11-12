const encoder = new TextEncoder();
const decoder = new TextDecoder();

function indexOf(bytes: Uint8Array, needle: Uint8Array, start = 0) {
  outer: for (
    let offset = start;
    offset <= bytes.length - needle.length;
    offset++
  ) {
    for (let index = 0; index < needle.length; index++)
      if (bytes[offset + index] !== needle[index]) continue outer;
    return offset;
  }
  return -1;
}

function append(left: Uint8Array, right: Uint8Array) {
  const bytes = new Uint8Array(left.length + right.length);
  bytes.set(left);
  bytes.set(right, left.length);
  return bytes;
}

export async function firstPdfPart(
  body: ReadableStream<Uint8Array>,
  contentType: string,
  onFirstByte: () => void,
) {
  const boundary = /boundary=(?:"([^"\r\n]+)"|([^;\s]+))/i.exec(contentType);
  const value = boundary?.[1] ?? boundary?.[2];
  if (!value || value.length > 70) {
    void body.cancel().catch(() => {});
    throw new Error("Invalid engine multipart boundary");
  }
  const reader = body.getReader();
  let buffer: Uint8Array = new Uint8Array();
  const separator = encoder.encode("\r\n\r\n");
  const delimiter = encoder.encode(`\r\n--${value}`);
  let size = 0;
  let firstByte = false;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  try {
    let end = -1;
    while (end < 0) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Missing engine PDF part");
      buffer = append(buffer, chunk.value);
      end = indexOf(buffer, separator);
      if ((end < 0 ? buffer.length : end) > 16_384)
        throw new Error("Engine multipart headers too large");
    }
    const headers = decoder.decode(buffer.subarray(0, end));
    if (
      !headers.startsWith(`--${value}\r\n`) ||
      !/content-disposition: form-data;[^\r\n]*\bname="pdf"(?:;|\r\n|$)/i.test(
        headers,
      ) ||
      !/content-type: application\/pdf(?:\r\n|$)/i.test(headers)
    )
      throw new Error("Engine must send the PDF first");
    buffer = buffer.subarray(end + separator.length);
  } catch (error) {
    cancel();
    throw error;
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          let end = indexOf(buffer, delimiter);
          while (end >= 0) {
            const suffix = end + delimiter.length;
            if (suffix + 2 > buffer.length) {
              end = -1;
              break;
            }
            if (
              (buffer[suffix] === 13 && buffer[suffix + 1] === 10) ||
              (buffer[suffix] === 45 && buffer[suffix + 1] === 45)
            )
              break;
            end = indexOf(buffer, delimiter, end + 1);
          }
          const length =
            end < 0 ? Math.max(0, buffer.length - delimiter.length - 1) : end;
          if (length > 0) {
            if (!firstByte) {
              firstByte = true;
              onFirstByte();
            }
            size += length;
            if (size > 20 * 1024 * 1024)
              throw new Error("Engine PDF exceeds 20 MiB");
            controller.enqueue(buffer.slice(0, length));
            buffer = buffer.subarray(length);
          }
          if (end >= 0) {
            if (!size) throw new Error("Engine returned an empty PDF");
            controller.close();
            cancel();
            return;
          }
          if (length > 0) return;
          const chunk = await reader.read();
          if (chunk.done) throw new Error("Truncated engine PDF part");
          buffer = append(buffer, chunk.value);
        }
      } catch (error) {
        controller.error(error);
        cancel();
      }
    },
    cancel,
  });
}
