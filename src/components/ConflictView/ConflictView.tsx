/**
 * 三方合并冲突编辑器（v0.5）：
 * - 上方（或两侧）只读展示 Base / Ours / Theirs 语法高亮参考内容；
 * - 下方（或中栏）提供“引导块解决”与“自由文本编辑”双模式 Result 编辑器；
 * - 支持 Prev/Next 冲突块跳转、单块/全局采用 Ours/Theirs/Both、撤销、保存与标记已解决（暂存）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { extensionOf } from "../../highlighter/extensions";
import type { TokenSpan } from "../../highlighter/tokenizer";
import {
  EMPTY_SIDE_TOKENS,
  getCachedHighlight,
  requestHighlight,
  type SideTokens,
} from "../../highlighter/workerClient";
import { useAppStore } from "../../store/app";
import { CodeContent } from "../DiffView/CodeCell";
import {
  AlertIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  CloseIcon,
  CodeIcon,
  ColumnsThreeIcon,
  SplitViewIcon,
  UndoIcon,
} from "../Icons";
import {
  applyConflictChoice,
  hasConflictMarkers,
  parseConflictSegments,
  resolveAllConflictBlocks,
  type ConflictBlock,
  type ConflictChoice,
} from "./conflictUtils";
import "./ConflictView.css";
import "../../highlighter/tokens.css";

type ConflictLayout = "stacked" | "columns";
type ResultMode = "guided" | "raw";

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (text.endsWith("\n") && lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function ReadOnlyCodePane({
  title,
  badge,
  tone,
  exists,
  content,
  tokens,
}: {
  title: string;
  badge: string;
  tone: "ours" | "theirs" | "base";
  exists: boolean;
  content: string;
  tokens: TokenSpan[][];
}) {
  const lines = useMemo(() => splitLines(content), [content]);
  return (
    <section className={`conflict-pane conflict-pane--${tone}`} aria-label={title}>
      <header className="conflict-pane-header">
        <span className={`conflict-pane-dot is-${tone}`} aria-hidden="true" />
        <span className="conflict-pane-title">{title}</span>
        <span className="conflict-pane-badge" title={badge}>
          {badge}
        </span>
      </header>
      <div className="conflict-pane-body">
        {!exists ? (
          <div className="conflict-pane-empty">此分支版本中该文件不存在或已被删除</div>
        ) : lines.length === 0 ? (
          <div className="conflict-pane-empty">（空文件）</div>
        ) : (
          <div className="conflict-code">
            {lines.map((line, i) => (
              <div key={i} className="conflict-code-row">
                <span className="conflict-code-ln">{i + 1}</span>
                <span className="conflict-code-text">
                  <CodeContent content={line} tokens={tokens[i] ?? []} charRanges={[]} side="new" />
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export function ConflictView() {
  const conflictPath = useAppStore((s) => s.conflictPath);
  const conflictDetail = useAppStore((s) => s.conflictDetail);
  const conflictLoading = useAppStore((s) => s.conflictLoading);
  const gitBusy = useAppStore((s) => s.gitBusy);
  const openConflictFile = useAppStore((s) => s.openConflictFile);
  const resolveConflictFile = useAppStore((s) => s.resolveConflictFile);
  const openFileDiff = useAppStore((s) => s.openFileDiff);
  const goBackToLog = useAppStore((s) => s.goBackToLog);

  const [layout, setLayout] = useState<ConflictLayout>("stacked");
  const [resultMode, setResultMode] = useState<ResultMode>("guided");
  const [showBase, setShowBase] = useState(false);

  const [draftState, setDraftState] = useState<{
    source: object | null;
    text: string;
    undo: string[];
  }>({ source: null, text: "", undo: [] });
  const [activeConflictIdx, setActiveConflictIdx] = useState(0);
  const [confirmUnresolvedStage, setConfirmUnresolvedStage] = useState(false);
  const [confirmDiscardLeave, setConfirmDiscardLeave] = useState(false);

  const conflictBlockRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // 切换或重新加载冲突文件时重置草稿（保持 render 期间同步无闪烁）
  const detailSource = conflictDetail;
  const resultText =
    draftState.source === detailSource ? draftState.text : (detailSource?.workdirContent ?? "");
  const undoStack = draftState.source === detailSource ? draftState.undo : [];

  useEffect(() => {
    setActiveConflictIdx(0);
    setConfirmUnresolvedStage(false);
    setConfirmDiscardLeave(false);
    setResultMode("guided");
  }, [detailSource]);

  const updateResultText = useCallback(
    (nextText: string) => {
      if (!detailSource) return;
      setConfirmUnresolvedStage(false);
      setConfirmDiscardLeave(false);
      setDraftState((prev) => {
        const curText = prev.source === detailSource ? prev.text : detailSource.workdirContent;
        const curUndo = prev.source === detailSource ? prev.undo : [];
        if (curText === nextText) return prev;
        return {
          source: detailSource,
          text: nextText,
          undo: [...curUndo.slice(-29), curText],
        };
      });
    },
    [detailSource],
  );

  const handleUndo = useCallback(() => {
    if (!detailSource) return;
    setConfirmUnresolvedStage(false);
    setDraftState((prev) => {
      if (prev.source !== detailSource || prev.undo.length === 0) return prev;
      const previousText = prev.undo[prev.undo.length - 1];
      return {
        source: detailSource,
        text: previousText,
        undo: prev.undo.slice(0, -1),
      };
    });
  }, [detailSource]);

  const handleReset = useCallback(() => {
    if (!detailSource) return;
    updateResultText(detailSource.workdirContent);
  }, [detailSource, updateResultText]);

  // 语法高亮 Ours & Theirs（复用现有 Web Worker）
  const langId = useMemo(
    () => extensionOf(conflictDetail?.path ?? conflictPath ?? ""),
    [conflictDetail?.path, conflictPath],
  );

  const [asyncTokens, setAsyncTokens] = useState<{ key: object | null; value: SideTokens }>({
    key: null,
    value: EMPTY_SIDE_TOKENS,
  });

  const cachedTokens = useMemo(() => {
    if (!conflictDetail || conflictDetail.isBinary || conflictDetail.tooLarge) {
      return EMPTY_SIDE_TOKENS;
    }
    return getCachedHighlight(conflictDetail.oursContent, conflictDetail.theirsContent, langId);
  }, [conflictDetail, langId]);

  useEffect(() => {
    if (
      !conflictDetail ||
      conflictDetail.isBinary ||
      conflictDetail.tooLarge ||
      cachedTokens !== null
    ) {
      return;
    }
    const key = conflictDetail;
    return requestHighlight(
      conflictDetail.oursContent,
      conflictDetail.theirsContent,
      langId,
      (res) => setAsyncTokens({ key, value: res }),
    );
  }, [conflictDetail, langId, cachedTokens]);

  const refTokens: SideTokens =
    cachedTokens ?? (asyncTokens.key === conflictDetail ? asyncTokens.value : EMPTY_SIDE_TOKENS);

  // 可选 Base 语法高亮
  const [baseAsyncTokens, setBaseAsyncTokens] = useState<{
    key: object | null;
    tokens: TokenSpan[][];
  }>({
    key: null,
    tokens: [],
  });
  const cachedBaseTokens = useMemo(() => {
    if (
      !showBase ||
      !conflictDetail ||
      !conflictDetail.baseExists ||
      conflictDetail.isBinary ||
      conflictDetail.tooLarge
    ) {
      return [];
    }
    return getCachedHighlight(conflictDetail.baseContent, "", langId)?.left ?? null;
  }, [showBase, conflictDetail, langId]);

  useEffect(() => {
    if (
      !showBase ||
      !conflictDetail ||
      !conflictDetail.baseExists ||
      conflictDetail.isBinary ||
      conflictDetail.tooLarge ||
      cachedBaseTokens !== null
    ) {
      return;
    }
    const key = conflictDetail;
    return requestHighlight(conflictDetail.baseContent, "", langId, (res) => {
      setBaseAsyncTokens({ key, tokens: res.left });
    });
  }, [showBase, conflictDetail, langId, cachedBaseTokens]);

  const baseTokens =
    cachedBaseTokens ?? (baseAsyncTokens.key === conflictDetail ? baseAsyncTokens.tokens : []);

  const segments = useMemo(() => parseConflictSegments(resultText), [resultText]);
  const conflictBlocks = useMemo(
    () => segments.filter((s): s is ConflictBlock => s.kind === "conflict"),
    [segments],
  );

  const unresolvedCount = conflictBlocks.length;
  const hasMarkers = useMemo(() => hasConflictMarkers(resultText), [resultText]);
  const isDirty = Boolean(conflictDetail && resultText !== conflictDetail.workdirContent);
  const busy = gitBusy !== null;

  const jumpToConflict = useCallback(
    (direction: -1 | 1) => {
      if (conflictBlocks.length === 0) return;
      const nextIdx =
        (activeConflictIdx + direction + conflictBlocks.length) % conflictBlocks.length;
      setActiveConflictIdx(nextIdx);
      const target = conflictBlocks[nextIdx];
      const el = conflictBlockRefs.current.get(target.id);
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
    },
    [conflictBlocks, activeConflictIdx],
  );

  const onChooseBlock = (block: ConflictBlock, choice: ConflictChoice) => {
    updateResultText(applyConflictChoice(resultText, block, choice));
  };

  const onSaveOnly = () => {
    if (!conflictDetail || busy) return;
    void resolveConflictFile(conflictDetail.path, resultText, false, false);
  };

  const onSaveAndStage = (forceWithMarkers = false) => {
    if (!conflictDetail || busy) return;
    if (hasMarkers && !forceWithMarkers) {
      setConfirmUnresolvedStage(true);
      return;
    }
    setConfirmUnresolvedStage(false);
    void resolveConflictFile(conflictDetail.path, resultText, true, false);
  };

  const onLeave = () => {
    if (isDirty) {
      setConfirmDiscardLeave(true);
      return;
    }
    goBackToLog();
  };

  if (!conflictDetail) {
    return (
      <section className="conflict-view conflict-view--empty" aria-label="三方合并冲突编辑器">
        <p className="conflict-placeholder">
          {conflictLoading ? "加载冲突详情中…" : "请选择一个冲突文件"}
        </p>
      </section>
    );
  }

  const isDeleteModify = !conflictDetail.oursExists || !conflictDetail.theirsExists;

  return (
    <section className="conflict-view" aria-label="三方合并冲突编辑器">
      <header className="conflict-header">
        <div className="conflict-header-left">
          <span className="conflict-badge-title">三方合并</span>
          <span className="conflict-path" title={conflictDetail.path}>
            {conflictDetail.path}
          </span>
          <span className={`conflict-count-pill${hasMarkers ? " is-unresolved" : " is-resolved"}`}>
            {unresolvedCount > 0
              ? `${unresolvedCount} 处冲突待解决`
              : hasMarkers
                ? "存在未闭合冲突标记"
                : "冲突标记已清除"}
          </span>
        </div>

        <div className="conflict-header-right">
          {conflictLoading && <span className="conflict-loading">刷新中…</span>}

          <div className="conflict-nav-group">
            <button
              type="button"
              className="conflict-icon-btn"
              disabled={conflictBlocks.length === 0}
              title="上一处冲突"
              aria-label="上一处冲突"
              onClick={() => jumpToConflict(-1)}
            >
              <ArrowUpIcon />
            </button>
            <button
              type="button"
              className="conflict-icon-btn"
              disabled={conflictBlocks.length === 0}
              title="下一处冲突"
              aria-label="下一处冲突"
              onClick={() => jumpToConflict(1)}
            >
              <ArrowDownIcon />
            </button>
          </div>

          {!conflictDetail.isBinary && !conflictDetail.tooLarge && (
            <>
              <div className="conflict-seg" role="group" aria-label="全局快速选择">
                <button
                  type="button"
                  disabled={busy || conflictBlocks.length === 0}
                  title="全部冲突块采用当前分支 (Ours)"
                  onClick={() => updateResultText(resolveAllConflictBlocks(resultText, "ours"))}
                >
                  全部 Ours
                </button>
                <button
                  type="button"
                  disabled={busy || conflictBlocks.length === 0}
                  title="全部冲突块采用传入变更 (Theirs)"
                  onClick={() => updateResultText(resolveAllConflictBlocks(resultText, "theirs"))}
                >
                  全部 Theirs
                </button>
              </div>

              {conflictDetail.baseExists && (
                <button
                  type="button"
                  className={`btn conflict-btn${showBase ? " is-toggled" : ""}`}
                  aria-pressed={showBase}
                  onClick={() => setShowBase((v) => !v)}
                >
                  Base
                </button>
              )}

              <div className="conflict-mode-group" role="group" aria-label="结果编辑模式">
                <button
                  type="button"
                  className={resultMode === "guided" ? "is-active" : ""}
                  onClick={() => setResultMode("guided")}
                >
                  引导块
                </button>
                <button
                  type="button"
                  className={resultMode === "raw" ? "is-active" : ""}
                  onClick={() => setResultMode("raw")}
                >
                  <CodeIcon />
                  <span>自由编辑</span>
                </button>
              </div>

              <div className="conflict-mode-group" role="group" aria-label="面板布局">
                <button
                  type="button"
                  className={layout === "stacked" ? "is-active" : ""}
                  title="上下对照（上方 Ours/Theirs，下方结果）"
                  aria-label="上下对照布局"
                  onClick={() => setLayout("stacked")}
                >
                  <SplitViewIcon />
                </button>
                <button
                  type="button"
                  className={layout === "columns" ? "is-active" : ""}
                  title="三栏并排（Ours | 结果 | Theirs）"
                  aria-label="三栏并排布局"
                  onClick={() => setLayout("columns")}
                >
                  <ColumnsThreeIcon />
                </button>
              </div>

              <button
                type="button"
                className="conflict-icon-btn"
                disabled={undoStack.length === 0}
                title="撤销上一步"
                aria-label="撤销上一步"
                onClick={handleUndo}
              >
                <UndoIcon />
              </button>
              <button
                type="button"
                className="btn conflict-btn"
                disabled={!isDirty}
                title="恢复为当前磁盘工作区内容"
                onClick={handleReset}
              >
                重置
              </button>
            </>
          )}

          <button
            type="button"
            className="btn conflict-btn"
            title="在普通 Diff 视图中查看工作区差异"
            onClick={() =>
              void openFileDiff(
                { kind: "workdir" },
                [
                  {
                    path: conflictDetail.path,
                    oldPath: null,
                    changeType: "modified",
                    additions: 0,
                    deletions: 0,
                  },
                ],
                0,
              )
            }
          >
            工作区 Diff
          </button>

          {!conflictDetail.isBinary && !conflictDetail.tooLarge && (
            <>
              <button
                type="button"
                className="btn conflict-btn"
                disabled={busy || !isDirty}
                onClick={onSaveOnly}
              >
                仅保存
              </button>
              <button
                type="button"
                className="btn btn-primary conflict-btn"
                disabled={busy}
                onClick={() => onSaveAndStage(false)}
              >
                <CheckIcon />
                <span>保存并标记已解决</span>
              </button>
            </>
          )}

          <button
            type="button"
            className="conflict-icon-btn"
            aria-label="关闭冲突编辑器"
            title="返回提交历史"
            onClick={onLeave}
          >
            <CloseIcon />
          </button>
        </div>
      </header>

      {confirmUnresolvedStage && (
        <div className="conflict-confirm-bar is-warn" role="alert">
          <AlertIcon />
          <span>
            合并结果中仍检测到冲突标记（{`<<<<<<< / >>>>>>>`}），确定直接写入并标记已解决吗？
          </span>
          <div className="conflict-confirm-ops">
            <button
              type="button"
              className="btn conflict-btn"
              onClick={() => setConfirmUnresolvedStage(false)}
            >
              继续解决
            </button>
            <button
              type="button"
              className="btn conflict-btn is-danger"
              disabled={busy}
              onClick={() => onSaveAndStage(true)}
            >
              强制保存并暂存
            </button>
          </div>
        </div>
      )}

      {confirmDiscardLeave && (
        <div className="conflict-confirm-bar" role="alert">
          <AlertIcon />
          <span>当前有未保存的冲突修改，确定放弃修改并返回提交列表吗？</span>
          <div className="conflict-confirm-ops">
            <button
              type="button"
              className="btn conflict-btn"
              onClick={() => setConfirmDiscardLeave(false)}
            >
              留在编辑器
            </button>
            <button
              type="button"
              className="btn conflict-btn is-danger"
              onClick={() => {
                setConfirmDiscardLeave(false);
                goBackToLog();
              }}
            >
              放弃修改并返回
            </button>
          </div>
        </div>
      )}

      {isDeleteModify && !conflictDetail.isBinary && !conflictDetail.tooLarge && (
        <div className="conflict-confirm-bar" role="region" aria-label="删除/修改冲突快速处理">
          <AlertIcon />
          <span>
            检测到存在/删除冲突（Ours：{conflictDetail.oursExists ? "保留文件" : "已删除"}，Theirs：
            {conflictDetail.theirsExists ? "保留文件" : "已删除"}）
          </span>
          <div className="conflict-confirm-ops">
            {conflictDetail.oursExists && (
              <button
                type="button"
                className="btn conflict-btn"
                disabled={busy}
                onClick={() =>
                  void resolveConflictFile(
                    conflictDetail.path,
                    conflictDetail.oursContent,
                    true,
                    false,
                  )
                }
              >
                采用 Ours 并标记解决
              </button>
            )}
            {conflictDetail.theirsExists && (
              <button
                type="button"
                className="btn conflict-btn"
                disabled={busy}
                onClick={() =>
                  void resolveConflictFile(
                    conflictDetail.path,
                    conflictDetail.theirsContent,
                    true,
                    false,
                  )
                }
              >
                采用 Theirs 并标记解决
              </button>
            )}
            <button
              type="button"
              className="btn conflict-btn is-danger"
              disabled={busy}
              onClick={() => void resolveConflictFile(conflictDetail.path, "", true, true)}
            >
              删除文件并标记解决
            </button>
          </div>
        </div>
      )}

      {conflictDetail.isBinary || conflictDetail.tooLarge ? (
        <div className="conflict-special-state">
          <AlertIcon />
          <p>
            {conflictDetail.isBinary
              ? "二进制文件不支持文本级三方合并，请从下方直接选择保留哪个版本："
              : "文件体积过大（超过 5MB），不支持在线文本合并，请使用外部工具处理或直接选择版本："}
          </p>
          <div className="conflict-special-actions">
            {conflictDetail.oursExists && !conflictDetail.isBinary && (
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() =>
                  void resolveConflictFile(
                    conflictDetail.path,
                    conflictDetail.oursContent,
                    true,
                    false,
                  )
                }
              >
                采用 Ours 并暂存
              </button>
            )}
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void openConflictFile(conflictDetail.path)}
            >
              刷新磁盘状态
            </button>
          </div>
        </div>
      ) : (
        <div className={`conflict-workspace is-${layout}`}>
          {layout === "stacked" ? (
            <>
              <div className={`conflict-ref-row${showBase ? " has-base" : ""}`}>
                <ReadOnlyCodePane
                  title="当前分支 (Ours)"
                  badge={conflictDetail.oursLabel}
                  tone="ours"
                  exists={conflictDetail.oursExists}
                  content={conflictDetail.oursContent}
                  tokens={refTokens.left}
                />
                {showBase && (
                  <ReadOnlyCodePane
                    title="共同祖先 (Base)"
                    badge="Ancestor"
                    tone="base"
                    exists={conflictDetail.baseExists}
                    content={conflictDetail.baseContent}
                    tokens={baseTokens}
                  />
                )}
                <ReadOnlyCodePane
                  title="传入变更 (Theirs)"
                  badge={conflictDetail.theirsLabel}
                  tone="theirs"
                  exists={conflictDetail.theirsExists}
                  content={conflictDetail.theirsContent}
                  tokens={refTokens.right}
                />
              </div>
              <ResultEditorPane
                resultMode={resultMode}
                resultText={resultText}
                segments={segments}
                activeConflictIdx={activeConflictIdx}
                conflictBlocks={conflictBlocks}
                blockRefs={conflictBlockRefs}
                onChangeText={updateResultText}
                onChooseBlock={onChooseBlock}
                onSwitchToRaw={() => setResultMode("raw")}
              />
            </>
          ) : (
            <div className={`conflict-cols-row${showBase ? " has-base" : ""}`}>
              <ReadOnlyCodePane
                title="当前分支 (Ours)"
                badge={conflictDetail.oursLabel}
                tone="ours"
                exists={conflictDetail.oursExists}
                content={conflictDetail.oursContent}
                tokens={refTokens.left}
              />
              {showBase && (
                <ReadOnlyCodePane
                  title="共同祖先 (Base)"
                  badge="Ancestor"
                  tone="base"
                  exists={conflictDetail.baseExists}
                  content={conflictDetail.baseContent}
                  tokens={baseTokens}
                />
              )}
              <ResultEditorPane
                resultMode={resultMode}
                resultText={resultText}
                segments={segments}
                activeConflictIdx={activeConflictIdx}
                conflictBlocks={conflictBlocks}
                blockRefs={conflictBlockRefs}
                onChangeText={updateResultText}
                onChooseBlock={onChooseBlock}
                onSwitchToRaw={() => setResultMode("raw")}
              />
              <ReadOnlyCodePane
                title="传入变更 (Theirs)"
                badge={conflictDetail.theirsLabel}
                tone="theirs"
                exists={conflictDetail.theirsExists}
                content={conflictDetail.theirsContent}
                tokens={refTokens.right}
              />
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ResultEditorPane({
  resultMode,
  resultText,
  segments,
  activeConflictIdx,
  conflictBlocks,
  blockRefs,
  onChangeText,
  onChooseBlock,
  onSwitchToRaw,
}: {
  resultMode: ResultMode;
  resultText: string;
  segments: ReturnType<typeof parseConflictSegments>;
  activeConflictIdx: number;
  conflictBlocks: ConflictBlock[];
  blockRefs: React.MutableRefObject<Map<number, HTMLDivElement>>;
  onChangeText: (next: string) => void;
  onChooseBlock: (block: ConflictBlock, choice: ConflictChoice) => void;
  onSwitchToRaw: () => void;
}) {
  const activeBlockId = conflictBlocks[activeConflictIdx]?.id ?? -1;

  return (
    <section className="conflict-pane conflict-pane--result" aria-label="合并结果编辑器">
      <header className="conflict-pane-header">
        <span className="conflict-pane-dot is-result" aria-hidden="true" />
        <span className="conflict-pane-title">合并结果 (Result)</span>
        <span className="conflict-pane-badge">
          {resultMode === "guided" ? "交互块解决" : "纯文本编辑"}
        </span>
      </header>
      <div className="conflict-pane-body conflict-result-body">
        {resultMode === "raw" ? (
          <textarea
            className="conflict-raw-textarea"
            aria-label="合并结果文本编辑器"
            spellCheck={false}
            value={resultText}
            onChange={(e) => onChangeText(e.target.value)}
          />
        ) : segments.length === 0 ? (
          <div className="conflict-pane-empty">结果为空</div>
        ) : (
          <div className="conflict-guided-list">
            {segments.map((seg, idx) => {
              if (seg.kind === "text") {
                const lines = splitLines(seg.content);
                return (
                  <div key={`t:${idx}`} className="conflict-plain-block">
                    {lines.map((line, li) => (
                      <div key={li} className="conflict-code-row">
                        <span className="conflict-code-ln">{seg.startLine + li}</span>
                        <span className="conflict-code-text">{line || " "}</span>
                      </div>
                    ))}
                  </div>
                );
              }
              const isActive = seg.id === activeBlockId;
              return (
                <div
                  key={`c:${seg.id}`}
                  ref={(el) => {
                    if (el) blockRefs.current.set(seg.id, el);
                    else blockRefs.current.delete(seg.id);
                  }}
                  className={`conflict-block${isActive ? " is-active" : ""}`}
                >
                  <div className="conflict-block-toolbar">
                    <span className="conflict-block-label">
                      冲突 #{seg.id + 1} · 第 {seg.startLine}–{seg.endLine} 行
                    </span>
                    <div className="conflict-block-actions">
                      <button
                        type="button"
                        className="conflict-pick-btn is-ours"
                        onClick={() => onChooseBlock(seg, "ours")}
                      >
                        采用 Ours ({seg.oursLabel})
                      </button>
                      <button
                        type="button"
                        className="conflict-pick-btn is-theirs"
                        onClick={() => onChooseBlock(seg, "theirs")}
                      >
                        采用 Theirs ({seg.theirsLabel})
                      </button>
                      <button
                        type="button"
                        className="conflict-pick-btn"
                        onClick={() => onChooseBlock(seg, "both-ours-first")}
                      >
                        保留双方
                      </button>
                      <button
                        type="button"
                        className="conflict-pick-btn"
                        title="先保留 Theirs，再保留 Ours"
                        onClick={() => onChooseBlock(seg, "both-theirs-first")}
                      >
                        Theirs+Ours
                      </button>
                      {seg.baseText !== null && (
                        <button
                          type="button"
                          className="conflict-pick-btn"
                          onClick={() => onChooseBlock(seg, "base")}
                        >
                          采用 Base
                        </button>
                      )}
                      <button type="button" className="conflict-pick-btn" onClick={onSwitchToRaw}>
                        手动编辑
                      </button>
                    </div>
                  </div>
                  <div className="conflict-block-sides">
                    <div className="conflict-block-side is-ours">
                      <div className="conflict-block-side-cap">Ours · {seg.oursLabel}</div>
                      <pre className="conflict-block-pre">
                        {seg.oursText || "（空内容 / 删除）"}
                      </pre>
                    </div>
                    {seg.baseText !== null && (
                      <div className="conflict-block-side is-base">
                        <div className="conflict-block-side-cap">
                          Base · {seg.baseLabel ?? "Ancestor"}
                        </div>
                        <pre className="conflict-block-pre">{seg.baseText || "（空内容）"}</pre>
                      </div>
                    )}
                    <div className="conflict-block-side is-theirs">
                      <div className="conflict-block-side-cap">Theirs · {seg.theirsLabel}</div>
                      <pre className="conflict-block-pre">
                        {seg.theirsText || "（空内容 / 删除）"}
                      </pre>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

export default ConflictView;
