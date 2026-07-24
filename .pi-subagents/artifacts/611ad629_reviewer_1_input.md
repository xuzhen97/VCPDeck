# Task for reviewer

[Read from: D:\VCPHub\VCPDeck\docs\, D:\VCPHub\VCPDeck\README.md, D:\VCPHub\VCPDeck\packages\shared\src\index.ts, D:\VCPHub\VCPDeck\packages\server\prisma\schema.prisma]

只读审阅 VCPDeck 的 docs/server-client-interaction-design.md 及 README/docs 中和文件传输、Storage、FileRef、Job 有关的设计，并与当前代码对照。回答：设计上文件管理是否应该属于 Job；Socket.IO 是否传文件本体；控制面/数据面应该如何分；当前实现离设计还缺什么。引用明确路径/章节或行号。不要编辑文件。

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