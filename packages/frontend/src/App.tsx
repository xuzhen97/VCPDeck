import { BrowserRouter } from "react-router-dom";
import { AppRoutes } from "@/app/routes";
import { SdkProvider } from "@/api/context";
import { AuthProvider } from "@/auth-context";

export default function App() {
	return (
		<BrowserRouter>
			<SdkProvider>
				<AuthProvider>
					<AppRoutes />
				</AuthProvider>
			</SdkProvider>
		</BrowserRouter>
	);
}
