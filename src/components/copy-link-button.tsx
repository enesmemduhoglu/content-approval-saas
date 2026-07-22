"use client";

import { useState } from "react";

export function CopyLinkButton({ token }: { token: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    const url = `${window.location.origin}/approve/${token}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Onay linki:", url);
    }
  }

  return (
    <button
      type="button"
      className="button-secondary"
      data-approval-token={token}
      onClick={copy}
    >
      {copied ? "Kopyalandı" : "Onay linkini kopyala"}
    </button>
  );
}
