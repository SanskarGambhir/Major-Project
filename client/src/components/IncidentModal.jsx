import { useEffect, useState } from 'react';
import { X, CheckCircle2, AlertTriangle, ShieldCheck, Activity, Brain, Clock, Zap } from 'lucide-react';
import { Card } from './ui/card';
import { Button } from './ui/button';
import { WorkflowStages } from './WorkflowStages';
import { cn } from '../lib/utils';
import { ago, severityClass, statusClass, statusLabel, typeLabel } from '../lib/format';
import { api } from '../lib/api';

export function IncidentModal({ incident, onClose, onApprove, onReject, busy }) {
  const [runs, setRuns] = useState([]);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [activeTab, setActiveTab] = useState('overview'); // 'overview' | 'runs' | 'rca'

  useEffect(() => {
    if (!incident?.id) return;
    setLoadingRuns(true);
    api.get(`/api/incidents/${incident.id}/runs`)
      .then((r) => setRuns(r.data ?? []))
      .catch(() => setRuns([]))
      .finally(() => setLoadingRuns(false));
  }, [incident?.id]);

  if (!incident) return null;

  const isAwaitingApproval = incident.status === 'AWAITING_APPROVAL';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="relative w-full max-w-3xl rounded-xl border border-border bg-card text-card-foreground shadow-2xl overflow-hidden my-8 animate-in fade-in zoom-in-95 duration-200">
        
        {/* Modal Header */}
        <div className="flex items-start justify-between border-b border-border px-6 py-4 bg-muted/30">
          <div>
            <div className="flex items-center gap-2.5">
              <span className="font-mono text-lg font-bold tracking-tight text-primary">{incident.id}</span>
              <span className={cn('rounded border px-2 py-0.5 text-xs font-semibold', severityClass(incident.severity))}>
                {incident.severity ?? 'SEV3'}
              </span>
              <span className={cn('rounded px-2 py-0.5 text-xs font-medium', statusClass(incident.status))}>
                {statusLabel(incident.status)}
              </span>
            </div>
            <div className="mt-1 text-sm text-muted-foreground flex items-center gap-2">
              <span className="font-semibold text-foreground">{incident.service}</span>
              <span>·</span>
              <span>{typeLabel(incident.type)}</span>
              <span>·</span>
              <span className="flex items-center gap-1"><Clock className="size-3.5" /> Detected {ago(incident.detected_at)}</span>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} className="rounded-full size-8 hover:bg-muted">
            <X className="size-4" />
          </Button>
        </div>

        {/* Workflow Lifecycle Stages */}
        <div className="px-6 py-3 border-b border-border bg-background/50">
          <WorkflowStages status={incident.status} />
        </div>

        {/* Tab Navigation */}
        <div className="flex border-b border-border px-6 bg-muted/10 gap-4">
          <button
            onClick={() => setActiveTab('overview')}
            className={cn('py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors',
              activeTab === 'overview' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground')}
          >
            AI Diagnosis & Actions
          </button>
          <button
            onClick={() => setActiveTab('runs')}
            className={cn('py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors flex items-center gap-1.5',
              activeTab === 'runs' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground')}
          >
            Agent Telemetry <span className="text-xs bg-muted px-1.5 py-0.5 rounded-full">{runs.length}</span>
          </button>
          {incident.rca_report && (
            <button
              onClick={() => setActiveTab('rca')}
              className={cn('py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors',
                activeTab === 'rca' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground')}
            >
              Postmortem (RCA)
            </button>
          )}
        </div>

        {/* Modal Body */}
        <div className="p-6 space-y-5 max-h-[60vh] overflow-y-auto">
          {activeTab === 'overview' && (
            <>
              {/* Root Cause Card */}
              <div className="rounded-lg border border-border p-4 bg-muted/20 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm font-semibold text-primary">
                    <Brain className="size-4" /> AI Root Cause Analysis
                  </div>
                  {incident.confidence !== undefined && incident.confidence !== null && (
                    <span className="text-xs font-mono bg-primary/10 text-primary px-2 py-0.5 rounded border border-primary/20">
                      Confidence: {(incident.confidence * 100).toFixed(0)}%
                    </span>
                  )}
                </div>
                <p className="text-sm font-medium text-foreground leading-relaxed">
                  {incident.root_cause || 'Analysis in progress or no root cause recorded.'}
                </p>
              </div>

              {/* Evidence Points */}
              {incident.evidence && incident.evidence.length > 0 && (
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                    <Activity className="size-3.5" /> Evidence & Telemetry Findings
                  </h4>
                  <ul className="space-y-1.5 text-xs text-muted-foreground bg-muted/10 p-3 rounded-lg border border-border">
                    {incident.evidence.map((ev, i) => (
                      <li key={i} className="flex items-start gap-2">
                        <span className="text-primary font-bold">•</span>
                        <span>{ev}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Proposed Remediation Action */}
              {incident.proposed_action && (
                <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-sm font-semibold text-emerald-500">
                      <Zap className="size-4" /> Proposed Remediation Plan
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 px-2 py-0.5 rounded border border-emerald-500/20">
                        Risk: {incident.risk ?? 'LOW'}
                      </span>
                    </div>
                  </div>

                  <div className="text-sm">
                    <span className="font-mono font-bold text-foreground">{incident.proposed_action}</span> on <span className="font-semibold text-primary">{incident.target || incident.service}</span>
                  </div>

                  {incident.reasoning && (
                    <p className="text-xs text-muted-foreground italic">
                      "{incident.reasoning}"
                    </p>
                  )}

                  {isAwaitingApproval && (
                    <div className="flex gap-3 pt-2">
                      <Button
                        size="sm"
                        onClick={() => onApprove(incident.id)}
                        disabled={busy}
                        className="bg-emerald-600 hover:bg-emerald-700 text-white font-medium"
                      >
                        <CheckCircle2 className="size-4 mr-1.5" /> Approve & Execute Action
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onReject(incident.id)}
                        disabled={busy}
                        className="border-red-500/30 text-red-500 hover:bg-red-500/10"
                      >
                        <AlertTriangle className="size-4 mr-1.5" /> Escalate to Human
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {activeTab === 'runs' && (
            <div className="space-y-3">
              {loadingRuns ? (
                <div className="text-center py-6 text-sm text-muted-foreground">Loading agent run traces...</div>
              ) : runs.length === 0 ? (
                <div className="text-center py-6 text-sm text-muted-foreground">No agent run traces recorded yet.</div>
              ) : (
                <div className="divide-y divide-border rounded-lg border border-border overflow-hidden">
                  {runs.map((r, i) => (
                    <div key={i} className="p-3.5 text-xs space-y-1.5 bg-card hover:bg-muted/30 transition-colors">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold uppercase tracking-wider text-primary">{r.agent}</span>
                          <span className="px-1.5 py-0.2 rounded text-[10px] font-mono bg-muted text-muted-foreground border border-border">
                            {r.provider} ({r.model || 'rules'})
                          </span>
                        </div>
                        <span className="font-mono text-muted-foreground">{r.latency_ms} ms</span>
                      </div>
                      {r.error && (
                        <div className="text-[11px] text-amber-500 font-mono">{r.error}</div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === 'rca' && incident.rca_report && (
            <div className="rounded-lg border border-border p-4 bg-muted/10 font-mono text-xs whitespace-pre-wrap leading-relaxed">
              {incident.rca_report}
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="flex justify-end border-t border-border px-6 py-3 bg-muted/20">
          <Button variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
