'use client';

import React, { useState, useEffect } from 'react';
import { useLanguage } from '@/context/LanguageContext';
import { FollowUpCase, PharmacistIntervention } from '@/lib/types';
import { api } from '@/lib/api';
import {
  AlertTriangle,
  Flame,
  CheckCircle2,
  Clock,
  PhoneCall,
  UserCheck,
  Calendar,
  FileCheck,
  Plus,
  RefreshCw,
  Search,
  MessageSquare,
  ShieldAlert,
} from 'lucide-react';

interface FollowUpsViewProps {
  initialFilter?: string;
  onSelectPatient?: (patientId: string) => void;
}

export const FollowUpsView: React.FC<FollowUpsViewProps> = ({
  initialFilter = '',
  onSelectPatient,
}) => {
  const { t, isRTL } = useLanguage();
  const [cases, setCases] = useState<FollowUpCase[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [priorityFilter, setPriorityFilter] = useState(initialFilter === 'problem' ? 'urgent' : '');
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  // Intervention Modal State
  const [selectedCase, setSelectedCase] = useState<FollowUpCase | null>(null);
  const [showInterventionModal, setShowInterventionModal] = useState(false);
  const [showCloseModal, setShowCloseModal] = useState(false);
  const [closureReason, setClosureReason] = useState('');

  const [interventionData, setInterventionData] = useState({
    contact_attempted: true,
    contact_method: 'phone_call',
    patient_reported_reason: '',
    action_taken: '',
    referral_indicated: false,
    referral_notes: '',
    next_follow_up_date: '',
    outcome_notes: '',
    mark_case_resolved: false,
  });

  const loadCases = async () => {
    setIsLoading(true);
    try {
      const params: Record<string, string> = {};
      if (statusFilter) params.status = statusFilter;
      if (priorityFilter) params.priority = priorityFilter;

      const res = await api.getFollowUps(params);
      setCases(res.results || []);
    } catch (err) {
      console.error('Error loading follow-up cases:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadCases();
  }, [statusFilter, priorityFilter]);

  const handleRecordIntervention = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCase) return;
    try {
      await api.addIntervention(selectedCase.id, interventionData);
      setShowInterventionModal(false);
      setActionNotice('Pharmacist intervention documented successfully. Case updated.');
      loadCases();
    } catch (err: any) {
      alert(`Error saving intervention: ${err.message}`);
    }
  };

  const handleCloseCase = async () => {
    if (!selectedCase || !closureReason) return;
    try {
      await api.closeCase(selectedCase.id, closureReason);
      setShowCloseModal(false);
      setClosureReason('');
      setActionNotice('Follow-up case closed with documented outcome.');
      loadCases();
    } catch (err: any) {
      alert(`Error closing case: ${err.message}`);
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      {/* Header and Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-amber-400" />
            <span>{t('followups')} & Clinical Interventions</span>
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Manage flagged patient cases, record counseling interventions, and track doctor referrals.
          </p>
        </div>

        <button
          onClick={loadCases}
          className="p-2 bg-slate-800 hover:bg-slate-700 rounded-xl text-slate-300 transition-colors self-start sm:self-auto"
        >
          <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {actionNotice && (
        <div className="bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 px-4 py-3 rounded-2xl flex items-center justify-between text-xs animate-in fade-in">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{actionNotice}</span>
          </div>
          <button onClick={() => setActionNotice(null)} className="text-slate-400 hover:text-slate-200">✕</button>
        </div>
      )}

      {/* Filter Tabs */}
      <div className="p-4 rounded-2xl bg-slate-900/80 border border-slate-800 flex flex-wrap items-center gap-3">
        <select
          value={priorityFilter}
          onChange={(e) => setPriorityFilter(e.target.value)}
          className="bg-slate-950/60 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-300 focus:outline-none focus:border-emerald-500"
        >
          <option value="">All Priorities</option>
          <option value="urgent">{t('urgent')}</option>
          <option value="high">{t('high')}</option>
          <option value="medium">{t('medium')}</option>
          <option value="low">{t('low')}</option>
        </select>

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="bg-slate-950/60 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-300 focus:outline-none focus:border-emerald-500"
        >
          <option value="">All Case Statuses ({cases.length})</option>
          <option value="open">Open (Awaiting Pharmacist)</option>
          <option value="in_progress">In Progress (Contacted)</option>
          <option value="resolved">Resolved</option>
          <option value="closed">Closed</option>
        </select>
      </div>

      {/* Cases List */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {isLoading ? (
          <div className="col-span-2 p-12 text-center text-slate-400">
            <RefreshCw className="w-6 h-6 animate-spin mx-auto text-emerald-400 mb-2" />
            <p className="text-xs">Loading follow-up cases...</p>
          </div>
        ) : cases.length === 0 ? (
          <div className="col-span-2 p-12 text-center border border-dashed border-slate-800 rounded-2xl space-y-2">
            <CheckCircle2 className="w-8 h-8 mx-auto text-emerald-400 opacity-60" />
            <p className="text-sm font-semibold text-slate-300">No open follow-up cases</p>
            <p className="text-xs text-slate-500">All alerts have been reviewed or resolved.</p>
          </div>
        ) : (
          cases.map((c) => {
            const isUrgent = c.priority === 'urgent' || c.priority === 'high';
            const isClosed = c.status === 'closed';

            return (
              <div
                key={c.id}
                className={`p-6 rounded-2xl bg-slate-900/90 border space-y-4 shadow-xl transition-all ${
                  isUrgent ? 'border-rose-500/40 bg-rose-950/5' : 'border-slate-800'
                }`}
              >
                {/* Header */}
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span
                        className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider ${
                          c.priority === 'urgent'
                            ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40 animate-pulse'
                            : c.priority === 'high'
                            ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                            : 'bg-blue-500/20 text-blue-300 border border-blue-500/40'
                        }`}
                      >
                        {c.priority}
                      </span>
                      <span className="text-xs font-mono text-slate-400">#{c.id.slice(0, 8)}</span>
                    </div>
                    <h3
                      onClick={() => onSelectPatient && onSelectPatient(c.patient)}
                      className="text-base font-bold text-slate-100 hover:text-emerald-300 cursor-pointer transition-colors mt-1"
                    >
                      {c.patient_name}
                    </h3>
                  </div>

                  <span
                    className={`text-xs px-2.5 py-1 rounded-md font-medium ${
                      c.status === 'open'
                        ? 'bg-rose-500/10 text-rose-300'
                        : c.status === 'in_progress'
                        ? 'bg-amber-500/10 text-amber-300'
                        : 'bg-emerald-500/10 text-emerald-300'
                    }`}
                  >
                    {c.status}
                  </span>
                </div>

                {/* Reason & Explanation */}
                <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800 text-xs space-y-1">
                  <div className="flex items-center gap-1.5 font-semibold text-slate-200">
                    <Flame className="w-3.5 h-3.5 text-rose-400" />
                    <span>{c.trigger_reason_display}</span>
                  </div>
                  <p className="text-slate-400 leading-relaxed">{c.trigger_notes}</p>
                </div>

                {/* Documented Interventions */}
                {c.interventions && c.interventions.length > 0 && (
                  <div className="space-y-2 pt-2 border-t border-slate-800/80">
                    <p className="text-[11px] font-bold text-slate-400 uppercase">Documented Actions ({c.interventions.length}):</p>
                    {c.interventions.map((iv) => (
                      <div key={iv.id} className="p-2.5 rounded-lg bg-slate-800/50 text-xs space-y-1">
                        <div className="flex justify-between text-[11px] text-slate-400">
                          <span>{iv.pharmacist_name || 'Pharmacist'} • {iv.contact_method_display}</span>
                          <span>{new Date(iv.created_at).toLocaleDateString()}</span>
                        </div>
                        <p className="text-slate-200">{iv.action_taken}</p>
                        {iv.referral_indicated && (
                          <p className="text-amber-300 text-[11px] font-medium">⚠️ Prescribing Doctor Referral Advised</p>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Card Footer with Actions */}
                <div className="pt-3 border-t border-slate-800/80 flex items-center justify-between gap-3 text-xs">
                  <span className="text-slate-400 flex items-center gap-1">
                    <Clock className="w-3.5 h-3.5" />
                    Due: {c.due_date}
                  </span>

                  {!isClosed ? (
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => {
                          setSelectedCase(c);
                          setShowInterventionModal(true);
                        }}
                        className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold transition-colors flex items-center gap-1"
                      >
                        <UserCheck className="w-3.5 h-3.5" />
                        <span>Document Action</span>
                      </button>
                      <button
                        onClick={() => {
                          setSelectedCase(c);
                          setShowCloseModal(true);
                        }}
                        className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
                      >
                        Close Case
                      </button>
                    </div>
                  ) : (
                    <span className="text-[11px] text-slate-500">Case closed ({c.closure_reason})</span>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Record Intervention Modal */}
      {showInterventionModal && selectedCase && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4 z-50 animate-in fade-in">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-lg p-6 space-y-5">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-bold text-slate-100 flex items-center gap-2">
                <UserCheck className="w-5 h-5 text-emerald-400" />
                <span>{t('recordIntervention')}</span>
              </h3>
              <button onClick={() => setShowInterventionModal(false)} className="text-slate-400">✕</button>
            </div>

            <p className="text-xs text-slate-400">
              Documenting action for patient <strong>{selectedCase.patient_name}</strong> ({selectedCase.trigger_reason_display}).
            </p>

            <form onSubmit={handleRecordIntervention} className="space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-300 mb-1">Contact Method</label>
                  <select
                    value={interventionData.contact_method}
                    onChange={(e) => setInterventionData({ ...interventionData, contact_method: e.target.value })}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-slate-200"
                  >
                    <option value="phone_call">Phone Call (مكالمة هاتفية)</option>
                    <option value="in_person">In-Person at Pharmacy (زيارة بالصيدلية)</option>
                    <option value="whatsapp_chat">WhatsApp Direct Chat</option>
                  </select>
                </div>

                <div>
                  <label className="block font-semibold text-slate-300 mb-1">Next Follow-Up Date</label>
                  <input
                    type="date"
                    value={interventionData.next_follow_up_date}
                    onChange={(e) => setInterventionData({ ...interventionData, next_follow_up_date: e.target.value })}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-slate-200"
                  />
                </div>
              </div>

              <div>
                <label className="block font-semibold text-slate-300 mb-1">Patient Reported Reason / Barrier</label>
                <input
                  type="text"
                  placeholder="e.g. Gastric distress, forgot during work, ran out of medication"
                  value={interventionData.patient_reported_reason}
                  onChange={(e) => setInterventionData({ ...interventionData, patient_reported_reason: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-slate-200"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-300 mb-1">Pharmacist Action Taken *</label>
                <textarea
                  required
                  rows={2}
                  placeholder="e.g. Counseled patient on taking with meals, adjusted reminder schedule, provided pillbox guidance"
                  value={interventionData.action_taken}
                  onChange={(e) => setInterventionData({ ...interventionData, action_taken: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-slate-200"
                />
              </div>

              <div className="flex items-center gap-2 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20">
                <input
                  type="checkbox"
                  id="refCheck"
                  checked={interventionData.referral_indicated}
                  onChange={(e) => setInterventionData({ ...interventionData, referral_indicated: e.target.checked })}
                  className="rounded text-amber-500 focus:ring-0"
                />
                <label htmlFor="refCheck" className="text-amber-300 font-semibold cursor-pointer">
                  Referral to Prescribing Physician Indicated
                </label>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="resCheck"
                  checked={interventionData.mark_case_resolved}
                  onChange={(e) => setInterventionData({ ...interventionData, mark_case_resolved: e.target.checked })}
                  className="rounded text-emerald-500 focus:ring-0"
                />
                <label htmlFor="resCheck" className="text-slate-300 cursor-pointer">
                  Mark case as Resolved
                </label>
              </div>

              <div className="flex justify-end gap-3 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowInterventionModal(false)}
                  className="px-4 py-2 rounded-xl bg-slate-800 text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold"
                >
                  Save Intervention Record
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Close Case Modal */}
      {showCloseModal && selectedCase && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4 z-50 animate-in fade-in">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-md p-6 space-y-4">
            <h3 className="text-base font-bold text-slate-100">Close Follow-Up Case</h3>
            <p className="text-xs text-slate-400">
              Please document the final clinical outcome before closing case #{selectedCase.id.slice(0, 8)}.
            </p>
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1">Closure Reason *</label>
              <textarea
                required
                rows={2}
                placeholder="e.g. Patient verified adherent and asymptomatic upon re-evaluation"
                value={closureReason}
                onChange={(e) => setClosureReason(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl p-2.5 text-xs text-slate-200"
              />
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <button onClick={() => setShowCloseModal(false)} className="px-4 py-2 rounded-xl bg-slate-800 text-slate-300 text-xs">
                Cancel
              </button>
              <button onClick={handleCloseCase} className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold">
                Confirm & Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
