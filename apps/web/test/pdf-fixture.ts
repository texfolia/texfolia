import { createHash } from "node:crypto";

type Bytes = Uint8Array<ArrayBuffer>;

const latin1 = (text: string) => Uint8Array.from(Buffer.from(text, "latin1"));
const md5 = (...parts: Uint8Array[]) => {
  const hash = createHash("md5");
  for (const part of parts) hash.update(part);
  return new Uint8Array(hash.digest());
};
function rc4(key: Uint8Array, data: Uint8Array) {
  const state = Uint8Array.from({ length: 256 }, (_, index) => index);
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + state[i]! + key[i % key.length]!) % 256;
    [state[i], state[j]] = [state[j]!, state[i]!];
  }
  let i = 0;
  let j = 0;
  return data.map((byte) => {
    i = (i + 1) % 256;
    j = (j + state[i]!) % 256;
    [state[i], state[j]] = [state[j]!, state[i]!];
    return byte ^ state[(state[i]! + state[j]!) % 256]!;
  });
}
// The padding that the PDF standard defines for passwords.
const padding = Uint8Array.from(
  Buffer.from(
    "28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a",
    "hex",
  ),
);
const padded = (password: string) =>
  new Uint8Array([...latin1(password), ...padding]).slice(0, 32);
const hex = (bytes: Uint8Array) => `<${Buffer.from(bytes).toString("hex")}>`;

/** PDF 1.4's original 40-bit encryption, which every reader still opens. */
function encryption(password: string) {
  const id = md5(latin1("texfolia fixture"));
  const permissions = -4;
  const owner = rc4(md5(padded(password)).slice(0, 5), padded(password));
  const key = md5(
    padded(password),
    owner,
    new Uint8Array(Int32Array.of(permissions).buffer),
    id,
  ).slice(0, 5);
  return {
    dictionary: `<< /Filter /Standard /V 1 /R 2 /O ${hex(owner)} /U ${hex(rc4(key, padding))} /P ${permissions} >>`,
    id: `[${hex(id)} ${hex(id)}]`,
    encrypt: (object: number, data: Uint8Array) =>
      rc4(
        md5(key, Uint8Array.of(object & 255, object >> 8, 0, 0, 0)).slice(
          0,
          10,
        ),
        data,
      ),
  };
}

/** A small PDF with one line of text on each page. */
export function pdfFixture({
  pages = ["PDF tab fixture"],
  width = 240,
  height = 160,
  password,
}: {
  pages?: string[];
  width?: number;
  height?: number;
  password?: string;
} = {}): Bytes {
  const secret = password === undefined ? undefined : encryption(password);
  const font = 3;
  const pageId = (index: number) => 4 + index * 2;
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${pageId(index)} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (const [index, text] of pages.entries()) {
    const contentId = pageId(index) + 1;
    const content = latin1(`BT /F1 16 Tf 24 100 Td (${text}) Tj ET`);
    const stored = secret ? secret.encrypt(contentId, content) : content;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${contentId} 0 R >>`,
      `<< /Length ${stored.length} >>\nstream\n${Buffer.from(stored).toString("latin1")}\nendstream`,
    );
  }
  const trailer = secret
    ? ` /Encrypt ${objects.push(secret.dictionary)} 0 R /ID ${secret.id}`
    : "";
  let output = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(output.length);
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = output.length;
  output += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1))
    output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  return latin1(
    `${output}trailer\n<< /Size ${offsets.length} /Root 1 0 R${trailer} >>\nstartxref\n${xref}\n%%EOF\n`,
  );
}
