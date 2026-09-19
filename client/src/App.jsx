// The whole routing story. No react-router: login is a conditional, the
// dashboard is the app, and incident detail is a drawer (Phase 4).

import Dashboard from './pages/Dashboard';

export default function App() {
  // Phase 5 replaces this with useAuth() and a <Login /> branch.
  return <Dashboard />;
}
