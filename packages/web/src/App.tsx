import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router-dom";
import { AuthLoadingScreen } from "./components/auth/LoginGate";
import { LandingPage } from "./pages/Landing";
import { PricingPage } from "./pages/Pricing";
import { EnterprisePage } from "./pages/Enterprise";
import { SecurityPage } from "./pages/Security";

const DashboardApp = lazy(() => import("./DashboardApp"));

export function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/pricing" element={<PricingPage />} />
      <Route path="/enterprise" element={<EnterprisePage />} />
      <Route path="/security" element={<SecurityPage />} />
      <Route
        path="*"
        element={<Suspense fallback={<AuthLoadingScreen />}><DashboardApp /></Suspense>}
      />
    </Routes>
  );
}

