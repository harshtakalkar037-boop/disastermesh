import { Navigate, Route, Routes } from "react-router-dom";
import { EdgePage } from "./edge";
import { Banner, Guard } from "./ui";
import {
  AlertsPage,
  AnalyticsPage,
  ConnectivityPage,
  GroupsPage,
  InboxPage,
  LoginPage,
  MapPage,
  OverviewPage,
  ReviewPage,
  SettingsPage,
  SimulatorPage,
  TeamsPage,
  TimelinePage,
  UnknownPage,
} from "./pages";

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<><Banner /><LoginPage /></>} />
      <Route path="/" element={<Guard><OverviewPage /></Guard>} />
      <Route path="/map" element={<Guard><MapPage /></Guard>} />
      <Route path="/inbox" element={<Guard><InboxPage /></Guard>} />
      <Route path="/groups" element={<Guard><GroupsPage /></Guard>} />
      <Route path="/teams" element={<Guard><TeamsPage /></Guard>} />
      <Route path="/connectivity" element={<Guard><ConnectivityPage /></Guard>} />
      <Route path="/unknown" element={<Guard><UnknownPage /></Guard>} />
      <Route path="/alerts" element={<Guard><AlertsPage /></Guard>} />
      <Route path="/review" element={<Guard><ReviewPage /></Guard>} />
      <Route path="/timeline" element={<Guard><TimelinePage /></Guard>} />
      <Route path="/analytics" element={<Guard><AnalyticsPage /></Guard>} />
      <Route path="/simulator" element={<Guard><SimulatorPage /></Guard>} />
      <Route path="/settings" element={<Guard><SettingsPage /></Guard>} />
      <Route path="/edge" element={<Guard><EdgePage /></Guard>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
