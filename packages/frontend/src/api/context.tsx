import { VcpDeckClient } from "@vcpdeck/sdk";
import { createContext, useContext, type ReactNode } from "react";

const defaultClient = new VcpDeckClient({
	baseUrl: "",
	auth: { type: "cookie" },
});
const SdkContext = createContext<VcpDeckClient>(defaultClient);

/** 向 React 组件提供 VCPDeck SDK。 */
export function SdkProvider({
	client = defaultClient,
	children,
}: {
	client?: VcpDeckClient;
	children: ReactNode;
}) {
	return <SdkContext.Provider value={client}>{children}</SdkContext.Provider>;
}

/** 读取当前 VCPDeck SDK。 */
export function useSdk(): VcpDeckClient {
	return useContext(SdkContext);
}
