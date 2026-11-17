---
name: markdown-report
description: 根据 CSV 统计摘要和显式材料生成中文 Markdown 报告，保留来源与统计数字。
tags:
  - markdown
  - 报告
  - 总结
triggers:
  - Markdown 报告
  - 生成报告
  - 销售报告
  - CSV 报告
  - report
---

# Markdown Report

Use this skill after CSV facts are available. Render a concise Markdown report
from `csv-summary.json` and the explicit source materials.

Write only inside the conductor artifact directory. Do not invent numbers that
are absent from the summary. Keep the source file name/hash visible.
