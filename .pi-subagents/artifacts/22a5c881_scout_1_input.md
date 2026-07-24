# Task for scout

只读研究本机 Pi 文档，针对将 Pi 嵌入 Node Client 并做审计。阅读 @earendil-works/pi-coding-agent 的 README、docs/sdk.md、docs/session-format.md，必要时 docs/rpc.md/json.md。输出：推荐 SDK/CLI JSON/RPC 哪种集成；可订阅的生命周期和工具事件；sessionId/sessionFile/JSONL 能否作为审计原始材料；取消、恢复、分支、compaction 的含义；哪些敏感数据不应落审计。给出文档路径依据。不要编辑项目。

---
Update progress at: D:\VCPHub\VCPDeck\.pi-subagents\artifacts\progress\22a5c881\progress.md

---
**Output:**
Write your findings to exactly this path: D:\VCPHub\VCPDeck\.pi-subagents\artifacts\outputs\22a5c881\context.md
This path is authoritative for this run.
Ignore any other output filename or output path mentioned elsewhere, including output destinations in the base agent prompt, system prompt, or task instructions.

## Acceptance Contract
Acceptance level: attested
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Return concrete findings with file paths and severity when applicable

Required evidence: review-findings, residual-risks

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
`criteriaSatisfied[].status` must be exactly one of: satisfied, not-satisfied, not-applicable.
`commandsRun[].result` must be exactly one of: passed, failed, not-run.
`manualNotes` and `notes` are optional strings; an empty string means no note and does not satisfy `manual-notes` evidence.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```