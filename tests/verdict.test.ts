import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeVerdictFromComments,
  normalizeCommentSeverity,
} from "../src/reviewCommentUtils.js";
import { ReviewComment } from "../src/types.js";

function comment(severity?: ReviewComment["severity"]): ReviewComment {
  return { path: "src/a.ts", line: 1, body: "note", severity };
}

describe("normalizeCommentSeverity", () => {
  it("keeps the two known tiers", () => {
    assert.equal(normalizeCommentSeverity("blocking"), "blocking");
    assert.equal(normalizeCommentSeverity("suggestion"), "suggestion");
  });

  it("treats a missing or unknown model value as blocking", () => {
    assert.equal(normalizeCommentSeverity(undefined), "blocking");
    assert.equal(normalizeCommentSeverity("nit"), "blocking");
    assert.equal(normalizeCommentSeverity(null), "blocking");
  });
});

describe("computeVerdictFromComments", () => {
  it("keeps the model verdict when there are no comments", () => {
    assert.equal(computeVerdictFromComments([], "APPROVE"), "APPROVE");
    assert.equal(computeVerdictFromComments([], "COMMENT"), "COMMENT");
  });

  it("forces REQUEST_CHANGES when any comment is blocking", () => {
    assert.equal(
      computeVerdictFromComments([comment("blocking")], "APPROVE"),
      "REQUEST_CHANGES"
    );
    assert.equal(
      computeVerdictFromComments([comment()], "APPROVE"),
      "REQUEST_CHANGES"
    );
  });

  it("downgrades APPROVE to COMMENT when every comment is a suggestion", () => {
    assert.equal(
      computeVerdictFromComments([comment("suggestion")], "APPROVE"),
      "COMMENT"
    );
  });

  it("leaves a model REQUEST_CHANGES in place for suggestion-only comments", () => {
    assert.equal(
      computeVerdictFromComments([comment("suggestion")], "REQUEST_CHANGES"),
      "REQUEST_CHANGES"
    );
  });
});
