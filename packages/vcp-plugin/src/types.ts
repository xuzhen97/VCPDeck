/**
 * VCP 标准协议结构定义
 */

export interface VcpRequest {
	command: string;
	params?: Record<string, unknown>;
	maid?: string;
	[key: string]: unknown;
}

export type VcpContentItem =
	| {
			type: "text";
			text: string;
	  }
	| {
			type: "image_url";
			image_url: { url: string };
	  };

export interface VcpResponse {
	status: "success" | "error";
	result?: {
		content: VcpContentItem[];
		messageForAI?: string;
	};
	content?: VcpContentItem[];
	messageForAI?: string;
	error?: string;
}

export interface PluginConfig {
	serverUrl: string;
	apiToken: string;
	publicShareBaseUrl: string;
	requestTimeoutMs?: number;
}
