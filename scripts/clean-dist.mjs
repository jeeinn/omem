#!/usr/bin/env node
// 构建前清空 dist（beta.9.1 / P1-A）。
//
// 为什么必须清：`tsc` 只写不删。源码里删掉的文件（例如 `896bd19` 删掉的
// `src/commands/pause.ts`）会在 `dist/` 留下孤儿 `pause.js`，而 `files: ["dist"]`
// 会把它一起打进 npm 包 —— 于是 `npm pack` 的 md5 取决于**构建历史**而不是 commit，
// 「同一个 commit 构建出同一个包」这句话就不成立（QA 用 clean worktree 构建，
// 三个 md5 三个样）。
import { rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
rmSync(join(root, 'dist'), { recursive: true, force: true });
console.log('[clean-dist] dist/ removed');
