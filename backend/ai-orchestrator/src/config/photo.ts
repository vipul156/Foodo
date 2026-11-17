import {
  uploadToCloudinary,
  resolveUploadFolder,
} from "@foodo/backend-common/cloudinary";

// ─── Dispute evidence (Cloudinary) ───────────────────────────
// The photo is the dispute's legal record, so it MUST outlive a
// single request:
//
//   intake (HTTP)   customer data-URI → Cloudinary → photoUrl
//   intake (queue)  channel already carried a photoUrl → unchanged
//   reasoning       both paths download the URL for the vision call
//
// That keeps ONE canonical carrier for evidence across both intake
// doors. It also keeps megabytes of base64 out of SQS: the queue
// caps a message at 256 KB, a phone photo encodes to ~10 MB — the
// work item holds the URL, never the bytes (see types.ts).
//
// Upload failures fail the intake LOUDLY (503): with no stored copy
// the case would inevitably escalate on "no photo evidence", silently
// punishing the customer for an infra glitch. Retrying is cheap; a
// dropped-evidence auto-refund is not.

const EVIDENCE_FOLDER = "disputes/evidence";
// ↑ joined with CLOUDINARY_FOLDER (default "foodo") at call time, so the
// namespace is per-stack env, not a constant baked into the bundle.

export interface StoredEvidence {
  /** Cloudinary secure_url — the durable copy. */
  photoUrl: string;
}

export async function storeDisputeEvidence(dataUri: string): Promise<StoredEvidence> {
  const secureUrl = await uploadToCloudinary({
    fileContent: dataUri,
    folder: resolveUploadFolder(EVIDENCE_FOLDER),
    tags: ["foodo", "dispute", "evidence"],
  });
  return { photoUrl: secureUrl };
}

// ─── Vision download ─────────────────────────────────────────
// The graph fetches the evidence back from its durable copy before
// the vision call. Timeout + size cap so a hostile/corrupt URL can
// never wedge a Lambda invocation or blow the memory allocation.

const DOWNLOAD_TIMEOUT_MS = Number(process.env.EVIDENCE_DOWNLOAD_TIMEOUT_MS) || 10_000;
const MAX_DOWNLOAD_BYTES = 15 * 1024 * 1024; // ≈ 10 MB decoded

export async function downloadImageBase64(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error(`Evidence download failed (${response.status}): ${url}`);
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_DOWNLOAD_BYTES) {
      console.error(`Evidence download too large (${buffer.byteLength} bytes) — skipping triage`);
      return null;
    }
    return buffer.toString("base64");
  } catch (err) {
    console.error(
      "Evidence download failed (continuing without vision triage):",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
