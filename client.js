// dsh-auto-wake 设置页：会话自动唤醒规则的增删查与试跑。
//
// 手写的 __ModuleLoader__ factory（无构建步骤），与 dsh-preset-plus / dsh-purge
// 同款写法。UI 只负责展示与触发，全部业务判定都在宿主侧（index.js），
// 走 /dsh-auto-wake/* 这组 REST 端点 —— 保证「网页上点」和「模型调工具」
// 走的是同一套代码路径，不会出现两边结论不一致。
window.__ModuleLoader__.load({ id: "dsh-auto-wake", factory: (require) => {
	var module = { exports: {} };
	var exports = module.exports;
	Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

	var react = require("react");
	var h = react.createElement;
	var useState = react.useState;
	var useEffect = react.useEffect;
	var useCallback = react.useCallback;

	var name = "dsh-auto-wake";
	var inject = ["slots"];

	// ── 样式令牌：沿用宿主主题变量，深浅色自动跟随 ──────────────────────
	var T = {
		ink: "var(--dsw-alias-label-primary, #e5e7eb)",
		muted: "var(--dsw-alias-label-tertiary, #9ca3af)",
		border: "var(--dsw-alias-border-l2, rgba(128,128,128,.25))",
		panel: "var(--dsw-alias-bg-layer-3, rgba(255,255,255,.035))",
		panel2: "var(--dsw-alias-bg-layer-2, rgba(255,255,255,.06))",
		accent: "var(--dsw-alias-brand-primary, #4d9cff)",
		ok: "var(--dsw-alias-state-success-primary, #35c46a)",
		warn: "var(--dsw-alias-state-warning-primary, #e0a83c)",
		err: "var(--dsw-alias-state-error-primary, #ef6b73)",
	};

	var WRAP = { width: "100%", maxWidth: "920px", display: "flex", flexDirection: "column", gap: "16px", color: T.ink, fontFamily: "inherit", fontSize: "13px" };
	var CARD = { border: "1px solid " + T.border, borderRadius: "12px", padding: "14px 15px", display: "flex", flexDirection: "column", gap: "10px", background: T.panel };
	var ROW = { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" };
	var INPUT = { width: "100%", padding: "8px 10px", fontSize: "13px", boxSizing: "border-box", background: T.panel2, color: T.ink, border: "1px solid " + T.border, borderRadius: "8px", outline: "none" };
	var TA = { width: "100%", minHeight: "76px", boxSizing: "border-box", fontSize: "13px", lineHeight: 1.55, padding: "9px 10px", resize: "vertical", background: T.panel2, color: T.ink, border: "1px solid " + T.border, borderRadius: "8px", outline: "none", fontFamily: "inherit" };
	var SELECT = { padding: "8px 10px", fontSize: "13px", borderRadius: "8px", border: "1px solid " + T.border, background: T.panel2, color: T.ink, maxWidth: "100%" };
	var BTN = { padding: "8px 14px", borderRadius: "8px", border: "1px solid transparent", cursor: "pointer", fontSize: "13px", fontWeight: 600, background: T.accent, color: "#fff" };
	var GHOST = { padding: "7px 11px", borderRadius: "8px", border: "1px solid " + T.border, cursor: "pointer", fontSize: "12px", fontWeight: 500, background: "transparent", color: T.ink };
	var DANGER = { padding: "6px 10px", borderRadius: "7px", border: "1px solid " + T.err, cursor: "pointer", fontSize: "12px", fontWeight: 500, background: "transparent", color: T.err };
	var LABEL = { fontSize: "12px", color: T.muted, fontWeight: 500 };
	var FIELD = { display: "flex", flexDirection: "column", gap: "4px", flex: "1 1 180px", minWidth: "160px" };

	// 只留两种最常用的诉求，其余能力（关键词、error 检测）保留在工具层。
	// 表单是给人顺手用的，不是把所有参数都摊开 —— 参数多到要看文档就是失败。
	var TRIGGERS = [
		{ value: "unfinished", label: "没干完就唤醒（报错 / 截断 / 未闭合）" },
		{ value: "always", label: "过了设定时间就唤醒" },
	];

	function fmtTime(value) {
		if (!value) return "—";
		var d = new Date(value);
		if (isNaN(d.getTime())) return "—";
		return d.toLocaleString();
	}

	// 规则状态 → 颜色与文案。tripped 是熔断，必须一眼能看出来。
	function statusOf(rule) {
		if (rule.status === "tripped") return { text: "已熔断", color: T.err };
		if (rule.status === "active") return { text: "运行中", color: T.ok };
		return { text: rule.status || "未知", color: T.muted };
	}

	function Badge(props) {
		return h("span", {
			style: {
				padding: "2px 8px", borderRadius: "999px", fontSize: "11px", fontWeight: 600,
				color: props.color, border: "1px solid " + props.color, background: "transparent",
			},
		}, props.text);
	}

	function Field(props) {
		return h("div", { style: FIELD },
			h("span", { style: LABEL }, props.label),
			props.children,
		);
	}

	function AutoWakeSettings() {
		var [rules, setRules] = useState([]);
		var [sessions, setSessions] = useState([]);
		// 被隐藏的已归档会话条数 —— 要让人知道「少的那几条去哪了」。
		var [hiddenArchived, setHiddenArchived] = useState(0);
		var [statePath, setStatePath] = useState("");
		var [notice, setNotice] = useState(null);
		var [busy, setBusy] = useState(false);
		var [loading, setLoading] = useState(true);
		var [showForm, setShowForm] = useState(false);
		// 正在编辑的规则 id；null 表示当前是「新建」模式。
		var [editingId, setEditingId] = useState(null);

		// 表单状态：新建规则用。
		var [form, setForm] = useState({
			sessionId: "",
			title: "",
			wakeText: "",
			trigger: "unfinished",
			keywords: "",
			everySeconds: 300,
			initialDelaySeconds: 0,
			mode: "queue",
			maxPerHour: 6,
			maxPerDay: 30,
			cooldownSeconds: 300,
			maxConsecutiveStalls: 3,
			// 时段默认全天；打开开关后才出现时间输入。
			useWindow: false,
			windowStart: "09:00",
			windowEnd: "22:00",
			// 「过了多久自动唤醒」，0 = 不等。
			idleMinutes: 0,
		});

		var say = function (kind, text) { setNotice({ kind: kind, text: text }); };

		var load = useCallback(function () {
			fetch("/dsh-auto-wake/list", { cache: "no-store" })
				.then(function (r) { return r.json(); })
				.then(function (d) {
					if (d.ok) {
						setRules(d.rules || []);
						setStatePath(d.statePath || "");
					} else {
						say("error", "读取规则失败：" + (d.message || d.code || ""));
					}
				})
				.catch(function (e) { say("error", "读取规则失败：" + e.message); })
				.finally(function () { setLoading(false); });
		}, []);

		var loadSessions = useCallback(function () {
			fetch("/dsh-auto-wake/sessions", { cache: "no-store" })
				.then(function (r) { return r.json(); })
				.then(function (d) {
					if (d.ok) {
						setSessions(d.sessions || []);
						setHiddenArchived(d.hiddenArchived || 0);
					}
				})
				.catch(function () { /* 会话列表是锦上添花，失败就让人手动填 id */ });
		}, []);

		useEffect(function () {
			load();
			loadSessions();
			// 15 秒轮询一次：额度/冷却/熔断状态是随宿主 tick 变的，
			// 不刷新的话页面上会看到过期数字。
			var timer = setInterval(load, 15000);
			return function () { clearInterval(timer); };
		}, [load, loadSessions]);

		// 把一条已有规则摊回表单状态。时段关开与静置分钟数都要逐项换算，
		// 否则用户点编辑会看到一堆默认值而不是他上次存的东西。
		var fillForm = function (rule) {
			setForm({
				sessionId: rule.sessionId,
				title: rule.title || "",
				wakeText: rule.wakeText || "",
				trigger: rule.trigger || "unfinished",
				keywords: (rule.keywords || []).join(" "),
				everySeconds: rule.everySeconds || 300,
				initialDelaySeconds: rule.initialDelaySeconds || 0,
				mode: rule.mode || "queue",
				maxPerHour: rule.maxPerHour || 6,
				maxPerDay: rule.maxPerDay || 30,
				cooldownSeconds: rule.cooldownSeconds || 300,
				maxConsecutiveStalls: rule.maxConsecutiveStalls || 3,
				useWindow: !!rule.windowStart,
				windowStart: rule.windowStart || "09:00",
				windowEnd: rule.windowEnd || "22:00",
				idleMinutes: rule.minIdleSeconds > 0 ? Math.round(rule.minIdleSeconds / 60) : 0,
			});
		};

		var startEdit = function (rule) {
			setEditingId(rule.id);
			fillForm(rule);
			setShowForm(true);
			setNotice(null);
			// 表单在页面下方，滚过去省得用户以为没反应。
			if (typeof window !== "undefined" && window.scrollTo) window.scrollTo({ top: 0, behavior: "smooth" });
		};

		var resetForm = function () {
			setEditingId(null);
			setForm(function (prev) { return Object.assign({}, prev, { title: "", wakeText: "", keywords: "" }); });
		};

		var submit = function () {
			// 前端只做最基本的存在性校验，真正的参数校验在宿主侧
			// （validateCreateArgs），两边规则唯一来源是宿主。
			if (form.sessionId.trim().length === 0) { say("error", "请选择或填写目标会话 id"); return; }
			if (form.wakeText.trim().length === 0) { say("error", "唤醒文本不能为空 —— 写清「接着做什么」"); return; }
			setBusy(true);
			var payload = {
				sessionId: form.sessionId.trim(),
				title: form.title.trim() || "自动唤醒",
				wakeText: form.wakeText,
				trigger: form.trigger,
				everySeconds: Number(form.everySeconds) || 300,
				initialDelaySeconds: Number(form.initialDelaySeconds) || 0,
				mode: form.mode,
				maxPerHour: Number(form.maxPerHour) || 6,
				maxPerDay: Number(form.maxPerDay) || 30,
				cooldownSeconds: Number(form.cooldownSeconds) || 300,
				maxConsecutiveStalls: Number(form.maxConsecutiveStalls) || 3,
			};
			if (form.trigger === "keyword") {
				payload.keywords = form.keywords.split(/[,，\s]+/).filter(function (x) { return x.length > 0; });
			}
			if (form.useWindow) {
				payload.windowStart = form.windowStart;
				payload.windowEnd = form.windowEnd;
			}
			if (Number(form.idleMinutes) > 0) {
				payload.minIdleSeconds = Math.round(Number(form.idleMinutes) * 60);
			}
			// 编辑与新建走不同的端点，但共用同一份表单与同一个 payload 形状。
			var isEdit = editingId !== null;
			var url = isEdit ? "/dsh-auto-wake/update" : "/dsh-auto-wake/create";
			if (isEdit) {
				payload.id = editingId;
				// 时段被关掉时要显式传空串，否则 mergeRuleEdit 会当成「不改」。
				if (!form.useWindow) { payload.windowStart = ""; payload.windowEnd = ""; }
				// 取消静置就显式清 0，不能靠省略。
				if (!(Number(form.idleMinutes) > 0)) payload.minIdleSeconds = 0;
			}
			fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			})
				.then(function (r) { return r.json(); })
				.then(function (d) {
					if (d.ok) {
						say("ok", isEdit ? ("已保存修改：" + d.id) : ("规则已创建：" + d.id));
						setShowForm(false);
						setEditingId(null);
						setForm(function (prev) { return Object.assign({}, prev, { title: "", wakeText: "", keywords: "" }); });
						load();
					} else {
						say("error", (isEdit ? "保存失败：" : "创建失败：") + (d.message || d.code || ""));
					}
				})
				.catch(function (e) { say("error", (isEdit ? "保存失败：" : "创建失败：") + e.message); })
				.finally(function () { setBusy(false); });
		};

		var remove = function (id) {
			if (!window.confirm("确定删除规则 " + id + " ？删除后不再自动唤醒该会话。")) return;
			setBusy(true);
			fetch("/dsh-auto-wake/delete", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: id }),
			})
				.then(function (r) { return r.json(); })
				.then(function (d) {
					if (d.ok) { say("ok", "已删除 " + id); load(); }
					else say("error", "删除失败：" + (d.message || d.code || ""));
				})
				.catch(function (e) { say("error", "删除失败：" + e.message); })
				.finally(function () { setBusy(false); });
		};

		// 试跑：两次调用，先 dryRun 看判定，再由用户决定要不要真发。
		// 不直接真发是因为真发会立刻唤醒对方会话，代价不可逆。
		// 熔断/暂停的规则要靠编辑接口带 resume:true 才能救回来 ——
		// 这是唯一合法的解熔断入口，比让人先删再建强。
		var resume = function (id) {
			setBusy(true);
			fetch("/dsh-auto-wake/update", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: id, resume: true }),
			})
				.then(function (r) { return r.json(); })
				.then(function (d) {
					if (d.ok) { say("ok", "已恢复运行：" + id); load(); }
					else say("error", "恢复失败：" + (d.message || d.code || ""));
				})
				.catch(function (e) { say("error", "恢复失败：" + e.message); })
				.finally(function () { setBusy(false); });
		};

		var probe = function (id) {
			setBusy(true);
			fetch("/dsh-auto-wake/run", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: id, dryRun: true }),
			})
				.then(function (r) { return r.json(); })
				.then(function (d) {
					if (d.ok && d.results && d.results.length > 0) {
						var one = d.results[0];
						say(
							one.fire ? "ok" : "info",
							"预判：" + (one.fire ? "会唤醒" : "不会唤醒") + "（" + one.reason + "）" +
							(one.busy ? "；该会话当前在跑" : ""),
						);
					} else {
						say("error", "试跑失败：" + ((d && (d.message || d.code)) || "无结果"));
					}
				})
				.catch(function (e) { say("error", "试跑失败：" + e.message); })
				.finally(function () { setBusy(false); });
		};

		var fire = function (id) {
			if (!window.confirm("现在真的唤醒一次？对方会话会立刻开始干活。")) return;
			setBusy(true);
			fetch("/dsh-auto-wake/run", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: id, dryRun: false }),
			})
				.then(function (r) { return r.json(); })
				.then(function (d) {
					if (d.ok && d.results && d.results.length > 0) say("ok", "已执行：" + d.results[0].result);
					else say("error", "执行失败：" + ((d && (d.message || d.code)) || "无结果"));
					load();
				})
				.catch(function (e) { say("error", "执行失败：" + e.message); })
				.finally(function () { setBusy(false); });
		};

		var set = function (key) {
			return function (event) { setForm(function (prev) { var o = Object.assign({}, prev); o[key] = event.target.value; return o; }); };
		};

		var noticeColor = notice
			? (notice.kind === "error" ? T.err : notice.kind === "ok" ? T.ok : T.muted)
			: T.muted;

		// ── 渲染 ──────────────────────────────────────────────────────────
		var header = h("div", { style: { display: "flex", flexDirection: "column", gap: "4px" } },
			h("div", { style: { fontSize: "15px", fontWeight: 700 } }, "会话自动唤醒"),
			h("div", { style: { fontSize: "12px", color: T.muted, lineHeight: 1.6 } },
				"给任意会话挂一条唤醒规则。宿主定期检查它最新一轮是不是「结束得不像结束」——",
				"LLM 报错、被 max-tokens 截断、或有未闭合的轮次 —— 命中就真的把它叫醒继续干活。",
			),
		);

		var toolbar = h("div", { style: ROW },
			h("button", {
				style: Object.assign({}, BTN, busy ? { opacity: 0.6, cursor: "default" } : {}),
				disabled: busy,
				onClick: function () {
					if (showForm) { setShowForm(false); setEditingId(null); }
					else { setEditingId(null); resetForm(); setShowForm(true); }
				},
			}, showForm ? "收起表单" : "＋ 新建规则"),
			h("button", { style: GHOST, onClick: load, disabled: busy }, "刷新"),
			h("span", { style: { marginLeft: "auto", fontSize: "12px", color: T.muted } },
				"共 " + rules.length + " 条规则"),
		);

		var isEditing = editingId !== null;
		var formBlock = showForm ? h("div", { style: CARD },
			h("div", { style: ROW },
				h("div", { style: { fontSize: "13px", fontWeight: 700 } },
					isEditing ? "编辑唤醒规则" : "新建唤醒规则"),
				isEditing
					? h("span", { style: { fontSize: "11px", color: T.muted } }, editingId)
					: null,
			),

			h("div", { style: ROW },
				h(Field, { label: "目标会话" },
					h("select", { style: SELECT, value: form.sessionId, onChange: set("sessionId") },
						h("option", { value: "" }, sessions.length === 0 ? "（暂无会话，可在下方手填 id）" : "— 选择会话 —"),
						sessions.map(function (s) {
							var when = s.updatedAt ? " · " + new Date(s.updatedAt).toLocaleString() : "";
							return h("option", { key: s.sessionId, value: s.sessionId },
								(s.title || "(无标题)") + " · " + s.sessionId.slice(0, 16) + "…" + when);
						}),
					),
				),
				h(Field, { label: "或直接填 session id" },
					h("input", {
						style: INPUT, value: form.sessionId, onChange: set("sessionId"),
						placeholder: "session-xxxxxxxx-xxxx-…",
					}),
				),
			),

			// 已归档的会话不在这里列出来（归档就是收起来，不该再自动叫醒它），
			// 但要说清被藏了几条，免得人以为会话丢了。
			hiddenArchived > 0
				? h("div", { style: { fontSize: "11px", color: T.muted, marginTop: "-4px" } },
					"另有 " + hiddenArchived + " 条已归档会话不在列表中（归档的会话不参与自动唤醒）。")
				: null,

			h("div", { style: ROW },
				h(Field, { label: "规则名" },
					h("input", { style: INPUT, value: form.title, onChange: set("title"), placeholder: "便于列表里辨认" }),
				),
				h(Field, { label: "触发条件" },
					h("select", { style: SELECT, value: form.trigger, onChange: set("trigger") },
						TRIGGERS.map(function (t) { return h("option", { key: t.value, value: t.value }, t.label); }),
					),
				),
			),

			form.trigger === "keyword"
				? h(Field, { label: "关键词（逗号或空格分隔，命中任意一个即唤醒）" },
					h("input", { style: INPUT, value: form.keywords, onChange: set("keywords"), placeholder: "例如：待续 下一步 TODO" }),
				)
				: null,

			// 两个最常用的时间约束：北京时间段 + 静置多久
			h("div", { style: { display: "flex", flexDirection: "column", gap: "8px", padding: "10px 12px", borderRadius: "10px", border: "1px solid " + T.border, background: T.panel2 } },
				h("div", { style: { fontSize: "12px", fontWeight: 700, color: T.ink } }, "什么时候可以唤醒"),

				h("label", { style: Object.assign({}, ROW, { cursor: "pointer", fontSize: "12px" }) },
					h("input", {
						type: "checkbox", checked: form.useWindow,
						onChange: function (e) { setForm(function (prev) { var o = Object.assign({}, prev); o.useWindow = e.target.checked; return o; }); },
					}),
					h("span", null, "只在指定北京时间段内唤醒"),
				),

				form.useWindow
					? h("div", { style: ROW },
						h(Field, { label: "开始（北京时间）" },
							h("input", { style: INPUT, type: "time", value: form.windowStart, onChange: set("windowStart") }),
						),
						h(Field, { label: "结束（北京时间）" },
							h("input", { style: INPUT, type: "time", value: form.windowEnd, onChange: set("windowEnd") }),
						),
						h("span", { style: { fontSize: "11px", color: T.muted, alignSelf: "flex-end", paddingBottom: "9px" } },
							"开始晚于结束 = 跨天（如 22:00–06:00）",
						),
					)
					: null,

				h(Field, { label: "静置多久后才唤醒（分钟，0 = 不限）" },
					h("input", {
						style: INPUT, type: "number", min: 0, value: form.idleMinutes,
						onChange: set("idleMinutes"), placeholder: "例如 30",
					}),
				),
				h("div", { style: { fontSize: "11px", color: T.muted, lineHeight: 1.6 } },
					"按目标会话最后一条动静算。设 30 就是「半小时没动静了才叫它」，",
					"不会因为轮询间隔而漂移。",
				),
			),

			h(Field, { label: "唤醒文本 —— 写清「接着做什么」，不要只写「继续」" },
				h("textarea", {
					style: TA, value: form.wakeText, onChange: set("wakeText"),
					placeholder: "例：接着把上一步没写完的测试跑完，然后回报结果。",
				}),
			),

			h("div", { style: ROW },
				h(Field, { label: "轮询间隔（秒，60–86400）" },
					h("input", { style: INPUT, type: "number", min: 60, max: 86400, value: form.everySeconds, onChange: set("everySeconds") }),
				),
				h(Field, { label: "首次检查延迟（秒，默认 0）" },
					h("input", { style: INPUT, type: "number", min: 0, value: form.initialDelaySeconds, onChange: set("initialDelaySeconds") }),
				),
				h(Field, { label: "投递模式" },
					h("select", { style: SELECT, value: form.mode, onChange: set("mode") },
						h("option", { value: "queue" }, "queue（排队，等当前轮结束）"),
						h("option", { value: "steer" }, "steer（插队，打断当前轮）"),
					),
				),
			),

			h("div", { style: { fontSize: "12px", color: T.muted, fontWeight: 600, marginTop: "2px" } }, "护栏"),
			h("div", { style: ROW },
				h(Field, { label: "每小时上限" },
					h("input", { style: INPUT, type: "number", min: 1, value: form.maxPerHour, onChange: set("maxPerHour") }),
				),
				h(Field, { label: "每天上限" },
					h("input", { style: INPUT, type: "number", min: 1, value: form.maxPerDay, onChange: set("maxPerDay") }),
				),
				h(Field, { label: "冷却（秒）" },
					h("input", { style: INPUT, type: "number", min: 0, value: form.cooldownSeconds, onChange: set("cooldownSeconds") }),
				),
				h(Field, { label: "连续无进展熔断" },
					h("input", { style: INPUT, type: "number", min: 1, value: form.maxConsecutiveStalls, onChange: set("maxConsecutiveStalls") }),
				),
			),

			h("div", { style: ROW },
				h("button", {
					style: Object.assign({}, BTN, busy ? { opacity: 0.6, cursor: "default" } : {}),
					disabled: busy, onClick: submit,
				}, busy ? "保存中…" : (isEditing ? "保存修改" : "创建")),
				h("button", {
					style: GHOST, disabled: busy,
					onClick: function () { setShowForm(false); setEditingId(null); },
				}, "取消"),
			),
		) : null;

		var noticeBlock = notice
			? h("div", {
				style: {
					padding: "9px 12px", borderRadius: "9px", fontSize: "12px", lineHeight: 1.6,
					color: noticeColor, border: "1px solid " + noticeColor, background: "transparent",
				},
			}, notice.text)
			: null;

		var emptyBlock = (!loading && rules.length === 0)
			? h("div", { style: Object.assign({}, CARD, { alignItems: "center", color: T.muted, padding: "26px 15px" }) },
				"还没有任何唤醒规则。点上面的「＋ 新建规则」加一条。")
			: null;

		var ruleCards = rules.map(function (rule) {
			var st = statusOf(rule);
			return h("div", { key: rule.id, style: CARD },
				h("div", { style: ROW },
					h("span", { style: { fontSize: "13px", fontWeight: 700 } }, rule.title || rule.id),
					h(Badge, { text: st.text, color: st.color }),
					h("span", { style: { fontSize: "11px", color: T.muted } }, rule.id),
					h("span", { style: { marginLeft: "auto", display: "flex", gap: "6px" } },
						h("button", { style: GHOST, disabled: busy, onClick: function () { startEdit(rule); } }, "编辑"),
						rule.status === "tripped" || rule.status === "paused"
							? h("button", {
								style: GHOST, disabled: busy,
								onClick: function () { resume(rule.id); },
							}, "恢复运行")
							: null,
						h("button", { style: GHOST, disabled: busy, onClick: function () { probe(rule.id); } }, "试跑"),
						h("button", { style: GHOST, disabled: busy, onClick: function () { fire(rule.id); } }, "立即唤醒"),
						h("button", { style: DANGER, disabled: busy, onClick: function () { remove(rule.id); } }, "删除"),
					),
				),

				h("div", { style: { fontSize: "12px", color: T.muted, fontFamily: "ui-monospace, monospace", wordBreak: "break-all" } },
					"会话 " + rule.sessionId),

				h("div", { style: { fontSize: "12px", color: T.ink, opacity: 0.85, lineHeight: 1.6 } },
					rule.wakeText),

				h("div", { style: Object.assign({}, ROW, { fontSize: "11px", color: T.muted, gap: "14px" }) },
					h("span", null, "触发：" + (rule.trigger === "keyword" ? "关键词 " + (rule.keywords || []).join("/") : rule.trigger)),
					rule.windowStart
						? h("span", { style: { color: rule.inWindow ? T.ok : T.warn } },
							"时段：" + rule.windowStart + "–" + rule.windowEnd + (rule.inWindow ? "（在段内）" : "（窗外，不唤醒）"))
						: h("span", null, "时段：全天"),
					rule.minIdleSeconds > 0
						? h("span", null, "静置：" + Math.round(rule.minIdleSeconds / 60) + " 分钟后才唤醒")
						: null,
					h("span", null, "间隔：" + rule.everySeconds + "s"),
					h("span", null, "本小时 " + rule.firesThisHour + "/" + rule.maxPerHour),
					h("span", null, "今日 " + rule.firesToday + "/" + rule.maxPerDay),
					h("span", null, "失败 " + (rule.failureCount || 0)),
					h("span", null, "无进展 " + (rule.stallCount || 0) + "/" + rule.maxConsecutiveStalls),
				),

				h("div", { style: Object.assign({}, ROW, { fontSize: "11px", color: T.muted, gap: "14px" }) },
					h("span", null, "上次检查：" + fmtTime(rule.lastCheckAt)),
					h("span", null, "上次唤醒：" + fmtTime(rule.lastFireAt)),
					h("span", null, "下次检查：" + fmtTime(rule.nextCheckAt)),
					rule.lastResult
						? h("span", { style: { color: String(rule.lastResult).indexOf("tripped") === 0 ? T.err : T.muted } },
							"结果：" + rule.lastResult)
						: null,
				),
			);
		});

		var footer = statePath
			? h("div", { style: { fontSize: "11px", color: T.muted, paddingTop: "2px" } },
				"状态文件：" + statePath + "（原子写；宿主重启后自动恢复）")
			: null;

		return h("div", { style: WRAP },
			header, toolbar, noticeBlock, formBlock, emptyBlock,
			h("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } }, ruleCards),
			footer,
		);
	}

	function apply(ctx) {
		ctx.slots.inject("settings.section", function () {
			return ctx.slots.register({
				name: "settings.section",
				id: "auto-wake",
				order: 46,
				label: function () { return "会话自动唤醒"; },
			}, function () { return h(AutoWakeSettings, null); });
		});
	}

	exports.name = name;
	exports.inject = inject;
	exports.apply = apply;
	return module.exports;
}});
