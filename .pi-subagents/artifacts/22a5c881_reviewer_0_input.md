# Task for reviewer

[Read from: D:\VCPHub\VCPDeck\packages\shared\src\index.ts, D:\VCPHub\VCPDeck\packages\server\prisma\schema.prisma, D:\VCPHub\VCPDeck\packages\server\src\job\, D:\VCPHub\VCPDeck\packages\server\src\events\events.gateway.ts, D:\VCPHub\VCPDeck\packages\client\src\, D:\VCPHub\VCPDeck\README.md, D:\VCPHub\VCPDeck\docs\server-client-interaction-design.md]

只读架构审阅：VCPDeck 未来在 client 上运行 Pi Agent，希望以 Job 为审计主线、支持全链路日志和失败后由 Agent 修复代码。结合当前 VCPDeck Job 实现（shared Job types、Prisma Job、scheduler、gateway、client executor）与 Pi SDK 文档（AgentSession、subscribe events、SessionManager、session JSONL），判断 Job 是否合适。重点回答：Job/Agent Session/Tool Call/Trace/Artifact 的正确关系；哪些应是 Job、哪些仅是事件；最小数据模型；断线与重试语义；主要风险。不要编辑文件。

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