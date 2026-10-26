/**
 * 质量闸门的状态门面（R1 第二步，2026-10-26）
 *
 * 为什么要有这一层：runQualityGate 的 8 种分支（applied / rejected / discarded /
 * ineffective / residue / skipped / pending / blocked）原本散落着对这些字段的直接读写：
 *   state.quality.{enabled, review, degraded, failStreak, backfilled, processed, lastBoundary}
 * 想读懂"这个块最后怎么样了"，得在 200 行里逐个追赋值；想改"降级阈值"又怕漏掉某一处。
 * 现在这些读写收口成 9 个方法，主循环只表达"发生了什么"，不碰字段本身。
 *
 * 下一步（R1 第三步）才能把主循环搬出单体：那时它只需要注入这个门面，
 * 不需要认识 state。
 *
 * 硬约束：
 *   · 本文件不引用 state / window / document / els；
 *   · 状态对象由 getQuality() 注入（页面传 () => state.quality，测试传普通对象）；
 *   · 上限与阈值由 opts 注入（index.html 的 QUALITY_* 常量仍是唯一来源），
 *     模块自带同值默认供独立测试使用。
 */

export const DEFAULT_PROCESSED_MAX = 2000;   // 已处理指纹上限（长会话防无限增长）
export const DEFAULT_DEGRADE_STREAK = 2;     // 审查连续异常 N 段 → 降级为纯静态

/**
 * @param {() => object} getQuality  返回 state.quality（同一个对象引用，不要每次新建）
 * @param {{processedMax?: number, degradeStreak?: number}} [opts]
 */
export function createQualityState(getQuality, opts = {}) {
    const processedMax = Number.isFinite(opts.processedMax) && opts.processedMax > 0
        ? opts.processedMax : DEFAULT_PROCESSED_MAX;
    const degradeStreak = Number.isFinite(opts.degradeStreak) && opts.degradeStreak > 0
        ? opts.degradeStreak : DEFAULT_DEGRADE_STREAK;
    const q = () => getQuality();

    return {
        // ---------- 开关 ----------
        /** 闸门总开关（🧩）。false 时整个闸门直接短路，不校验不审查 */
        isEnabled() {
            return !!q().enabled;
        },

        /** 该不该跑小模型审查：审查开关开着、且没因为连续异常降级 */
        isReviewOn() {
            const s = q();
            return !!s.review && !s.degraded;
        },

        isDegraded() {
            return !!q().degraded;
        },

        // ---------- 首次回填 ----------
        /** 是否还需要把历史代码的符号补进符号表（刷新页面 / 切回会话后为 true） */
        needBackfill() {
            return !q().backfilled;
        },

        markBackfilled() {
            q().backfilled = true;
        },

        // ---------- 已处理指纹 ----------
        hasProcessed(key) {
            return q().processed.has(key);
        },

        /**
         * 登记「已处理」指纹；超过上限时淘汰最早的一批。
         * Set 的迭代顺序 = 插入顺序，所以"最早的"就是迭代器前 N 个；
         * 一次淘汰 1/4（而不是全清）是为了长会话下平滑回收，不把仍在用的指纹丢掉。
         */
        touchProcessed(key) {
            const p = q().processed;
            if (p.size >= processedMax) {
                const it = p.values();
                for (let i = 0; i < Math.ceil(processedMax / 4); i++) {
                    const v = it.next();
                    if (v.done) break;
                    p.delete(v.value);
                }
            }
            p.add(key);
        },

        // ---------- 审查降级 ----------
        /**
         * 审查异常一次。返回 { streak, justDegraded }：
         * justDegraded 只在【本次刚跨过阈值】时为 true —— 调用方据此只提示一次。
         * 降级后 isReviewOn() 变 false，主循环自然不会再来累加。
         */
        bumpFailStreak() {
            const s = q();
            s.failStreak++;
            if (s.failStreak >= degradeStreak && !s.degraded) {
                s.degraded = true;
                return { streak: s.failStreak, justDegraded: true };
            }
            return { streak: s.failStreak, justDegraded: false };
        },

        resetFailStreak() {
            q().failStreak = 0;
        },

        // ---------- 边界上下文 ----------
        /** 上一段的尾部若干行，作为下一段审查的边界上下文（空串 = 无） */
        getLastBoundary() {
            return q().lastBoundary || '';
        },

        setLastBoundary(text) {
            q().lastBoundary = text || '';
        }
    };
}
