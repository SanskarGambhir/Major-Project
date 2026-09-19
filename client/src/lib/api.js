// =============================================================================
// REST client. "Do things" go through here; "learn things" come via socket.js.
// =============================================================================

import axios from 'axios';

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? 'http://localhost:3000',
  timeout: 15000,
});

// Attach the auth token when there is one (Phase 5). Harmless until then.
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// The calls the dashboard makes, named, so components never build URLs.
export const getHealth    = ()   => api.get('/api/health').then((r) => r.data);
export const getServices  = ()   => api.get('/api/services').then((r) => r.data);
export const getIncidents = ()   => api.get('/api/incidents').then((r) => r.data);
export const getIncident  = (id) => api.get(`/api/incidents/${id}`).then((r) => r.data);

// Doing things (Phase 3). Both return quickly; outcomes arrive over the socket.
export const postAction = ({ action, target, incidentId }) =>
  api.post('/api/actions', { action, target, incidentId }).then((r) => r.data);
export const simulate = (scenario) =>
  api.post(`/api/simulate/${scenario}`).then((r) => r.data);
