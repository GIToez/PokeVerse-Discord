import { writeFileSync } from "node:fs";

/**
 * Minimal MaxMind DB (v2) writer for tests: IPv4 tree, 24-bit records, and the data types
 * GeoIP records use (maps, strings, unsigned ints, booleans, arrays).
 */

type Value = string | number | boolean | Value[] | { [key: string]: Value };

function controlByte(type: number, size: number): Buffer {
  const extended = type > 7;
  const first = (extended ? 0 : type) << 5;
  let header: number[];
  if (size < 29) {
    header = [first | size];
  } else if (size < 285) {
    header = [first | 29, size - 29];
  } else {
    const rest = size - 285;
    header = [first | 30, rest >> 8, rest & 0xff];
  }
  if (extended) {
    header.splice(1, 0, type - 7);
  }
  return Buffer.from(header);
}

function unsigned(value: number): Buffer {
  const bytes: number[] = [];
  for (let rest = value; rest > 0; rest = Math.floor(rest / 256)) {
    bytes.unshift(rest % 256);
  }
  return Buffer.from(bytes);
}

function encode(value: Value, uint64 = false): Buffer {
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([controlByte(2, bytes.length), bytes]);
  }
  if (typeof value === "boolean") {
    return controlByte(14, value ? 1 : 0);
  }
  if (typeof value === "number") {
    const bytes = unsigned(value);
    return Buffer.concat([controlByte(uint64 ? 9 : 6, bytes.length), bytes]);
  }
  if (Array.isArray(value)) {
    return Buffer.concat([controlByte(11, value.length), ...value.map((item) => encode(item))]);
  }
  const entries = Object.entries(value);
  return Buffer.concat([
    controlByte(7, entries.length),
    ...entries.flatMap(([key, item]) => [encode(key), encode(item, key === "build_epoch")]),
  ]);
}

export interface MmdbNetwork {
  /** e.g. "81.2.69.0/24" */
  cidr: string;
  data: Record<string, Value>;
}

export function writeMmdb(file: string, networks: MmdbNetwork[], databaseType = "Test-City"): void {
  const EMPTY = -1;
  const nodes: Array<[number, number]> = [[EMPTY, EMPTY]];
  const data: Buffer[] = [];
  let dataSize = 0;
  const DATA = (offset: number) => -2 - offset;

  for (const network of networks) {
    const [address, bitsText] = network.cidr.split("/");
    const bits = Number(bitsText);
    const ip = address!.split(".").reduce((sum, octet) => sum * 256 + Number(octet), 0);
    const encoded = encode(network.data);
    const offset = dataSize;
    data.push(encoded);
    dataSize += encoded.length;
    let node = 0;
    for (let depth = 0; depth < bits; depth++) {
      const bit = (Math.floor(ip / 2 ** (31 - depth)) % 2) as 0 | 1;
      if (depth === bits - 1) {
        nodes[node]![bit] = DATA(offset);
      } else {
        if (nodes[node]![bit] < 0) {
          nodes.push([EMPTY, EMPTY]);
          nodes[node]![bit] = nodes.length - 1;
        }
        node = nodes[node]![bit];
      }
    }
  }

  const count = nodes.length;
  const record = (value: number) => (value === EMPTY ? count : value < 0 ? count + 16 + (-2 - value) : value);
  const tree = Buffer.alloc(count * 6);
  nodes.forEach(([left, right], index) => {
    tree.writeUIntBE(record(left), index * 6, 3);
    tree.writeUIntBE(record(right), index * 6 + 3, 3);
  });
  const metadata = encode({
    node_count: count,
    record_size: 24,
    ip_version: 4,
    database_type: databaseType,
    languages: ["en"],
    binary_format_major_version: 2,
    binary_format_minor_version: 0,
    build_epoch: 1_700_000_000,
    description: { en: "PokeVerse test database" },
  });
  writeFileSync(
    file,
    Buffer.concat([tree, Buffer.alloc(16), ...data, Buffer.from("\xab\xcd\xefMaxMind.com", "latin1"), metadata]),
  );
}
