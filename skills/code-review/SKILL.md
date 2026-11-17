---
name: code-review
description: 按清单审查显式提供的代码或补丁，输出问题、风险与验证建议；不自动修改文件。
tags:
  - review
  - 代码审查
triggers:
  - 代码审查
  - code review
  - 审查补丁
---

# Code Review

Review only the explicit materials in the current task.

1. List correctness, security and maintainability findings with file/line evidence.
2. Distinguish verified facts from assumptions.
3. Do not claim tests passed unless the host actually ran them.
4. This instruction package has no executable; the host executor performs the review.
