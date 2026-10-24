#!/usr/bin/env node
/**
 * Refresh `data/cty.dat` from country-files.com.
 *
 * The build never touches the network: it reads the checked-in copy of the file
 * (see `src/data/cty.ts`). This script is the only thing that goes out, and it
 * is run by hand — `npm run update:cty` — so a refresh is a reviewable commit.
 *
 * Three gates stand between the download and the working tree:
 *
 *   1. the bytes land in a temporary file next to the target, not on top of it;
 *   2. the payload is parsed far enough to prove it is the country file — a
 *      Cloudflare interstitial or a truncated transfer arrives with HTTP 200
 *      too, and overwriting a good file with either would take a week to notice;
 *   3. only then is it renamed into place, which is atomic within a directory.
 *
 * If anything fails the existing file is left untouched and the script exits
 * non-zero, so the trainer keeps working off the last known-good copy.
 *
 * To update by hand instead (no network access from the shell, or the site is
 * unreachable): download cty.dat from https://www.country-files.com/bigcty/
 * and save it over `data/cty.dat`.
 */
import { writeFile, rename, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const SOURCE = "https://www.country-files.com/cty/cty.dat";
const TARGET = fileURLToPath(new URL("../data/cty.dat", import.meta.url));

/** The file carries ~340 DXCC entities; anything near zero is not it. */
const MIN_RECORDS = 300;

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Check that the payload is a cty.dat. Returns the record count, or throws with
 * a list of what is wrong. Deliberately structural rather than checksum-based:
 * the file is revised weekly, and git may rewrite its line endings on checkout.
 */
function validate(text) {
  const problems = [];
  let records = 0;
  let terminated = false;

  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    if (line.startsWith("<")) {
      problems.push(`line ${index + 1}: looks like HTML, not the country file`);
      break;
    }
    if (line[0] === " ") {
      if (line.includes(";")) terminated = true;
      continue;
    }
    records += 1;
    const fields = line.split(":");
    if (fields.length < 9) {
      problems.push(`line ${index + 1}: ${fields.length - 1} colon fields, expected 8`);
      continue;
    }
    // The name may contain colons, so read the fields from the tail.
    const tail = fields.slice(-8);
    if (!Number.isFinite(Number.parseFloat(tail[3]))) {
      problems.push(`line ${index + 1}: unreadable latitude "${tail[3]}"`);
    }
    if (!Number.isFinite(Number.parseFloat(tail[4]))) {
      problems.push(`line ${index + 1}: unreadable longitude "${tail[4]}"`);
    }
  }

  if (records < MIN_RECORDS) {
    problems.push(`only ${records} records, expected at least ${MIN_RECORDS}`);
  }
  if (!terminated) {
    problems.push("no alias list is terminated by `;` — the file is truncated");
  }
  if (problems.length > 0) {
    throw new Error(problems.slice(0, 10).join("\n"));
  }
  return records;
}

async function main() {
  process.stdout.write(`fetching ${SOURCE}\n`);
  const response = await fetch(SOURCE, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const text = buffer.toString("ascii");
  const records = validate(text);

  const temp = `${TARGET}.download`;
  try {
    await writeFile(temp, buffer);
    await rename(temp, TARGET);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }

  process.stdout.write(
    `wrote data/cty.dat — ${records} records, ${buffer.length} bytes, sha256 ${sha256(buffer)}\n` +
      "review the diff, then commit it\n",
  );
}

main().catch((error) => {
  process.stderr.write(`update failed, data/cty.dat left unchanged:\n${error.message}\n`);
  process.exitCode = 1;
});
