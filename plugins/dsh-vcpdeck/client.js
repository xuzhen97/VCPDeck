/**
 * VCPDeck 面板的浏览器半。
 *
 * 只依赖宿主提供的 React（`require('react')`），不引入第二份 React；
 * 数据来自 Host 半的同源接口 `/api/vcpdeck/clients`，因此不涉及跨域。
 */
window.__ModuleLoader__.load({
	id: "@vcpdeck/dsh-panel",
	factory(require) {
		const React = require("react");
		const h = React.createElement;
		const { useCallback, useEffect, useState } = React;

		async function loadClients() {
			const response = await fetch("/api/vcpdeck/clients", {
				credentials: "same-origin",
			});
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}
			return response.json();
		}

		function Dot({ online }) {
			return h("span", {
				"aria-hidden": true,
				style: {
					width: 8,
					height: 8,
					borderRadius: 999,
					display: "inline-block",
					background: online ? "#34d399" : "rgba(148,163,184,0.8)",
				},
			});
		}

		function Row({ client }) {
			const canOpen = Boolean(client.dshWebUrl);
			return h(
				"li",
				{
					style: {
						display: "flex",
						alignItems: "center",
						gap: 12,
						padding: "10px 12px",
						border: "1px solid rgba(127,127,127,0.22)",
						borderRadius: 10,
						listStyle: "none",
					},
				},
				h(Dot, { online: client.online }),
				h(
					"div",
					{ style: { minWidth: 0, flex: 1 } },
					h(
						"div",
						{ style: { fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis" } },
						client.name || client.clientId,
					),
					h(
						"div",
						{
							style: {
								fontSize: 12,
								opacity: 0.7,
								overflow: "hidden",
								textOverflow: "ellipsis",
								whiteSpace: "nowrap",
							},
						},
						[client.hostname, client.online ? "在线" : "离线", canOpen ? "已登记远程 DSH" : "未登记远程 DSH"]
							.filter(Boolean)
							.join(" · "),
					),
				),
				h(
					"button",
					{
						type: "button",
						disabled: !canOpen,
						onClick: () => {
							window.open(client.dshWebUrl, "_blank", "noopener,noreferrer");
						},
						style: {
							padding: "6px 12px",
							borderRadius: 8,
							border: "1px solid rgba(127,127,127,0.3)",
							background: canOpen ? "rgba(99,102,241,0.15)" : "transparent",
							color: "inherit",
							cursor: canOpen ? "pointer" : "not-allowed",
							opacity: canOpen ? 1 : 0.5,
							flexShrink: 0,
						},
					},
					"打开 DSH",
				),
			);
		}

		function Panel() {
			const [state, setState] = useState({ phase: "loading", clients: [], error: null });

			const refresh = useCallback(async () => {
				setState((current) => ({ ...current, phase: "loading", error: null }));
				try {
					const payload = await loadClients();
					setState({ phase: "ready", clients: payload.clients ?? [], error: null });
				} catch (error) {
					setState((current) => ({
						...current,
						phase: "error",
						error: error instanceof Error ? error.message : "加载失败",
					}));
				}
			}, []);

			useEffect(() => {
				void refresh();
			}, [refresh]);

			const header = h(
				"div",
				{
					style: {
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						gap: 12,
						marginBottom: 12,
					},
				},
				h(
					"div",
					null,
					h("div", { style: { fontSize: 15, fontWeight: 600 } }, "VCPDeck 机器"),
					h(
						"div",
						{ style: { fontSize: 12, opacity: 0.7, marginTop: 2 } },
						"已登记远程 DSH 的机器可以一键打开完整 DSH 界面",
					),
				),
				h(
					"button",
					{
						type: "button",
						onClick: () => void refresh(),
						style: {
							padding: "6px 12px",
							borderRadius: 8,
							border: "1px solid rgba(127,127,127,0.3)",
							background: "transparent",
							color: "inherit",
							cursor: "pointer",
							flexShrink: 0,
						},
					},
					"刷新",
				),
			);

			if (state.phase === "loading" && state.clients.length === 0) {
				return h("div", { style: { padding: 24 } }, header, h("div", { style: { opacity: 0.7 } }, "正在读取机器…"));
			}
			if (state.phase === "error") {
				return h(
					"div",
					{ style: { padding: 24 } },
					header,
					h(
						"div",
						{ style: { padding: "12px 14px", border: "1px solid rgba(248,113,113,0.5)", borderRadius: 10, fontSize: 13 } },
						`无法读取 VCPDeck：${state.error ?? "未知错误"}`,
						h(
							"div",
							{ style: { marginTop: 6, opacity: 0.75 } },
							"检查插件配置里的 serverUrl 与 VCPDeck API token（或环境变量 VCPDECK_API_URL / VCPDECK_API_TOKEN）。",
						),
					),
				);
			}
			if (state.clients.length === 0) {
				return h(
					"div",
					{ style: { padding: 24 } },
					header,
					h("div", { style: { opacity: 0.7 } }, "VCPDeck 里还没有注册任何机器。"),
				);
			}
			return h(
				"div",
				{ style: { padding: 24, height: "100%", overflowY: "auto", boxSizing: "border-box" } },
				header,
				h(
					"ul",
					{ style: { display: "grid", gap: 8, padding: 0, margin: 0 } },
					state.clients.map((client) => h(Row, { key: client.clientId, client })),
				),
			);
		}

		/** 侧栏图标：一个表示"机器 + 通道"的简单方块，颜色跟随宿主主题。 */
		function Icon({ size = 20 }) {
			return h(
				"svg",
				{
					width: size,
					height: size,
					viewBox: "0 0 24 24",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 1.8,
					strokeLinecap: "round",
					"aria-hidden": true,
				},
				h("rect", { x: 3, y: 4, width: 18, height: 12, rx: 2 }),
				h("path", { d: "M8 20h8M12 16v4" }),
				h("path", { d: "M8.5 10.5h7" }),
			);
		}

		return {
			inject: ["slots"],
			apply(ctx) {
				ctx.slots.inject("sidebar.panellist", () =>
					ctx.slots.register(
						{ name: "sidebar.panellist", id: "vcpdeck", order: 60, label: () => "VCPDeck" },
						Icon,
					),
				);
				ctx.slots.inject("main", () =>
					ctx.slots.register({ name: "main", key: "vcpdeck" }, Panel),
				);
			},
		};
	},
});
