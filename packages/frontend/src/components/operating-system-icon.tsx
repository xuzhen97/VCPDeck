import type { ComponentProps } from "react";

/** 按 Client 操作系统显示统一风格的系统图标。 */
export function OperatingSystemIcon({
	os,
	className = "size-7",
}: {
	os: string;
	className?: string;
}) {
	const normalized = os.toLowerCase();
	if (normalized.includes("darwin") || normalized.includes("mac"))
		return <MacOsIcon className={className} />;
	if (normalized.includes("win")) return <WindowsIcon className={className} />;
	return <LinuxIcon className={className} />;
}

function WindowsIcon({ className }: ComponentProps<"svg">) {
	return (
		<svg
			role="img"
			aria-label="Windows"
			viewBox="0 0 24 24"
			className={className}
			fill="currentColor"
		>
			<path d="M3 5.1 10.7 4v7.3H3V5.1Zm8.8-1.25L21 2.5v8.8h-9.2V3.85ZM3 12.7h7.7V20L3 18.9v-6.2Zm8.8 0H21v8.8l-9.2-1.35V12.7Z" />
		</svg>
	);
}

function LinuxIcon({ className }: ComponentProps<"svg">) {
	return (
		<svg
			role="img"
			aria-label="Linux"
			viewBox="0 0 24 24"
			className={className}
			fill="none"
			stroke="currentColor"
			strokeWidth="1.6"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d="M8.2 10.2C8.4 6.1 9.7 3 12 3s3.6 3.1 3.8 7.2c1.7 1.8 2.7 4.4 2.2 6.7-.4 2-1.7 3.4-3.5 3.1a6.4 6.4 0 0 1-5 0c-1.8.3-3.1-1.1-3.5-3.1-.5-2.3.5-4.9 2.2-6.7Z" />
			<circle cx="10.2" cy="8.2" r=".7" fill="currentColor" stroke="none" />
			<circle cx="13.8" cy="8.2" r=".7" fill="currentColor" stroke="none" />
			<path d="m10.2 10.2 1.8 1 1.8-1M9.4 19.8 7 21M14.6 19.8 17 21" />
		</svg>
	);
}

function MacOsIcon({ className }: ComponentProps<"svg">) {
	return (
		<svg
			role="img"
			aria-label="macOS"
			viewBox="0 0 24 24"
			className={className}
			fill="currentColor"
		>
			<path d="M15.6 3c.1 1.1-.4 2.2-1.1 3-.8.8-1.9 1.3-3 1.2-.1-1.1.4-2.2 1.1-2.9.8-.8 2-1.3 3-1.3Zm3.9 13.4c-.5 1.2-1.1 2.3-1.9 3.4-.7 1-1.5 2.1-2.8 2.1-1.1 0-1.5-.7-2.8-.7-1.4 0-1.8.7-2.9.7-1.2 0-2.1-1.1-2.8-2.1C4.2 16.9 4 13.5 5.4 11.3A4.6 4.6 0 0 1 9.3 9c1.2 0 2.3.8 3 .8.7 0 2-.9 3.4-.8.6 0 2.5.2 3.7 2-2.9 1.7-2.4 5.4.1 6.4Z" />
		</svg>
	);
}
