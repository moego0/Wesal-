'use client';

import React, { useState, useEffect } from 'react';
import { useLanguage } from '@/context/LanguageContext';
import { Patient, MedicationRecord, ReminderEvent, FollowUpCase } from '@/lib/types';
import { api } from '@/lib/api';
import {
  ArrowLeft,
  Phone,
  CheckCircle2,
  Ban,
  Clock,
  Pill,
  Plus,
  Send,
  AlertTriangle,
  FileText,
  Calendar,
  Activity,
  Trash2,
  RefreshCw,
  Sparkles,
} from 'lucide-react';

interface PatientDetailViewProps {
  patientId: string;
  onBack: () => void;
  onNavigateToSimulator?: (phone: string) => void;
}

export const PatientDetailView: React.FC<PatientDetailViewProps> = ({
  patientId,
  onBack,
  onNavigateToSimulator,
}) => {
  const { t, isRTL } = useLanguage();
  const [patient, setPatient] = useState<Patient | null>(null);
  const [medications, setMedications] = useState<MedicationRecord[]>([]);
  const [timeline, setTimeline] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Modals
  const [showWithdrawModal, setShowWithdrawModal] = useState(false);
  const [withdrawReason, setWithdrawReason] = useState('Patient requested communication opt-out');
  const [showAddMedModal, setShowAddMedModal] = useState(false);
  const [isSendingTest, setIsSendingTest] = useState(false);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  // New Medication Form State
  const [newMed, setNewMed] = useState({
    name: '',
    dose: '',
    unit: 'mg',
    route: 'oral',
    frequency_description: 'Once daily in the morning',
    scheduled_times: ['08:30'],
    is_chronic: true,
    prescription_reference: '',
    special_instructions: '',
  });

  const loadPatientData = async () => {
    setIsLoading(true);
    try {
      const [patData, medsData, timelineData] = await Promise.all([
        api.getPatient(patientId),
        api.getMedications({ patient: patientId }),
        api.getPatientTimeline(patientId),
      ]);
      setPatient(patData);
      setMedications(medsData.results || []);
      setTimeline(timelineData.timeline || []);
    } catch (err) {
      console.error('Error loading patient detail:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadPatientData();
  }, [patientId]);

  const handleWithdrawConsent = async () => {
    try {
      const res = await api.withdrawConsent(patientId, withdrawReason);
      setShowWithdrawModal(false);
      setActionNotice(
        `Consent withdrawn. ${res.cancelled_reminders} pending future reminder jobs were cancelled automatically.`
      );
      loadPatientData();
    } catch (err: any) {
      alert(`Error withdrawing consent: ${err.message}`);
    }
  };

  const handleRenewConsent = async () => {
    try {
      await api.renewConsent(patientId);
      setActionNotice('Consent renewed successfully. Patient is now eligible for automated WhatsApp reminders.');
      loadPatientData();
    } catch (err: any) {
      alert(`Error renewing consent: ${err.message}`);
    }
  };

  const handleAddMedication = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.createMedication({
        ...newMed,
        patient: patientId,
      });
      setShowAddMedModal(false);
      setNewMed({
        name: '',
        dose: '',
        unit: 'mg',
        route: 'oral',
        frequency_description: 'Once daily in the morning',
        scheduled_times: ['08:30'],
        is_chronic: true,
        prescription_reference: '',
        special_instructions: '',
      });
      setActionNotice('Medication schedule created. Reminders will be generated for the authorized times.');
      loadPatientData();
    } catch (err: any) {
      alert(`Error adding medication: ${err.message}`);
    }
  };

  const handleStatusChange = async (medId: string, newStatus: string) => {
    const reason = prompt(`Reason for changing medication to ${newStatus}:`, 'Treatment course updated by pharmacist');
    if (!reason) return;
    try {
      const res = await api.changeMedicationStatus(medId, newStatus, reason);
      setActionNotice(`Medication marked as ${newStatus}. ${res.cancelled_reminders} pending reminders invalidated.`);
      loadPatientData();
    } catch (err: any) {
      alert(`Error updating status: ${err.message}`);
    }
  };

  const handleSendTestReminder = async () => {
    if (!patient) return;
    setIsSendingTest(true);
    try {
      const res = await api.sendTestMessage({
        phone_number: patient.phone_number,
        patient_name: patient.full_name,
      });
      setActionNotice(`WhatsApp reminder sent to ${patient.phone_number} (ID: ${res.provider_message_id || 'Mocked'})`);
      loadPatientData();
    } catch (err: any) {
      alert(`Error sending test WhatsApp reminder: ${err.message}`);
    } finally {
      setIsSendingTest(false);
    }
  };

  if (isLoading || !patient) {
    return (
      <div className="p-8 flex items-center justify-center min-h-[400px]">
        <div className="flex flex-col items-center gap-3">
          <RefreshCw className="w-8 h-8 animate-spin text-emerald-400" />
          <p className="text-sm text-slate-400">Loading patient profile & timeline...</p>
        </div>
      </div>
    );
  }

  const isConsented = patient.consent_status === 'consented';

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      {/* Back Button & Patient Header Card */}
      <div className="flex items-center gap-3">
        <button
          onClick={onBack}
          className="p-2 rounded-xl bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-100 transition-colors flex items-center gap-1.5 text-xs font-semibold"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to Patients</span>
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

      {/* Patient Profile Header */}
      <div className="rounded-2xl bg-slate-900/90 border border-slate-800 p-6 shadow-xl space-y-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-emerald-500/20 to-teal-500/20 border border-emerald-500/30 flex items-center justify-center text-xl font-bold text-emerald-400">
              {patient.full_name.charAt(0)}
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-3">
                <h2 className="text-xl font-bold text-slate-100">{patient.full_name}</h2>
                <span className="text-xs font-mono px-2 py-0.5 rounded-md bg-slate-800 text-slate-300 border border-slate-700">
                  {patient.patient_code}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-4 text-xs text-slate-400">
                <span className="flex items-center gap-1 font-mono text-emerald-400" dir="ltr">
                  <Phone className="w-3.5 h-3.5" />
                  {patient.phone_number}
                </span>
                <span>•</span>
                <span>Language: <strong className="text-slate-200">{patient.preferred_language === 'ar' ? 'العربية' : 'English'}</strong></span>
                <span>•</span>
                <span>Pharmacist: <strong className="text-slate-200">{patient.responsible_pharmacist_name || 'Assigned'}</strong></span>
              </div>
            </div>
          </div>

          {/* Quick Action Buttons */}
          <div className="flex flex-wrap items-center gap-2">
            {isConsented ? (
              <>
                <button
                  onClick={handleSendTestReminder}
                  disabled={isSendingTest}
                  className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-semibold flex items-center gap-1.5 transition-colors disabled:opacity-50"
                  title="Sends an instant reminder template to this patient's WhatsApp"
                >
                  <Send className="w-3.5 h-3.5 text-emerald-400" />
                  <span>{isSendingTest ? 'Sending...' : 'Send WhatsApp Reminder'}</span>
                </button>
                <button
                  onClick={() => setShowWithdrawModal(true)}
                  className="px-3 py-2 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 text-rose-300 text-xs font-semibold flex items-center gap-1.5 transition-colors"
                >
                  <Ban className="w-3.5 h-3.5" />
                  <span>{t('withdrawConsent')}</span>
                </button>
              </>
            ) : (
              <button
                onClick={handleRenewConsent}
                className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-md flex items-center gap-1.5 transition-colors"
              >
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>{t('renewConsent')}</span>
              </button>
            )}
          </div>
        </div>

        {/* Consent Details Banner */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-4 border-t border-slate-800/80 text-xs">
          <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800 space-y-1">
            <span className="text-slate-500 font-medium">Consent Status</span>
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${isConsented ? 'bg-emerald-400' : 'bg-rose-400'}`} />
              <strong className={isConsented ? 'text-emerald-300' : 'text-rose-300'}>
                {t(patient.consent_status)}
              </strong>
            </div>
          </div>

          <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800 space-y-1">
            <span className="text-slate-500 font-medium">Enrollment Status</span>
            <div className="text-slate-200 font-semibold">{t(patient.enrollment_status)}</div>
          </div>

          <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800 space-y-1">
            <span className="text-slate-500 font-medium">Registered Date</span>
            <div className="text-slate-200 font-semibold">
              {new Date(patient.created_at).toLocaleDateString()}
            </div>
          </div>
        </div>
      </div>

      {/* Grid: Medications & Activity Timeline */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column: Authorized Medications (1 Col) */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
              <Pill className="w-4 h-4 text-emerald-400" />
              <span>{t('activeMedications')} ({medications.length})</span>
            </h3>
            {isConsented && (
              <button
                onClick={() => setShowAddMedModal(true)}
                className="px-2.5 py-1.5 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 text-xs font-semibold flex items-center gap-1 transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add Med</span>
              </button>
            )}
          </div>

          <div className="space-y-3">
            {medications.length === 0 ? (
              <div className="p-6 text-center border border-dashed border-slate-800 rounded-2xl text-slate-500 text-xs">
                No medications configured for this patient yet.
              </div>
            ) : (
              medications.map((med) => {
                const isActive = med.status === 'active';
                return (
                  <div
                    key={med.id}
                    className={`p-4 rounded-2xl bg-slate-900/80 border transition-all space-y-3 ${
                      isActive ? 'border-slate-800' : 'border-slate-800/60 opacity-60'
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div>
                        <h4 className="font-bold text-slate-100 text-sm">{med.name}</h4>
                        <p className="text-xs text-emerald-400 font-medium">
                          {med.dose} {med.unit} • {med.route}
                        </p>
                      </div>
                      <span
                        className={`text-[10px] font-bold px-2 py-0.5 rounded-md uppercase ${
                          isActive
                            ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                            : 'bg-slate-800 text-slate-400'
                        }`}
                      >
                        {med.status}
                      </span>
                    </div>

                    <div className="space-y-1 text-xs text-slate-400">
                      <p><strong>Frequency:</strong> {med.frequency_description}</p>
                      <div className="flex items-center gap-1.5 flex-wrap pt-1">
                        <span className="text-[11px] text-slate-500">Scheduled:</span>
                        {med.scheduled_times.map((t_str, idx) => (
                          <span
                            key={idx}
                            className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700 font-mono text-emerald-300 text-[11px]"
                          >
                            {t_str}
                          </span>
                        ))}
                      </div>
                      {med.prescription_reference && (
                        <p className="text-[11px] text-slate-500 pt-1">Rx: {med.prescription_reference}</p>
                      )}
                    </div>

                    {/* Change Status Action */}
                    {isActive && (
                      <div className="pt-2 border-t border-slate-800/80 flex items-center justify-end gap-2">
                        <button
                          onClick={() => handleStatusChange(med.id, 'paused')}
                          className="text-[11px] text-amber-400 hover:text-amber-300 px-2 py-1 bg-amber-500/10 rounded-md"
                        >
                          Pause
                        </button>
                        <button
                          onClick={() => handleStatusChange(med.id, 'discontinued')}
                          className="text-[11px] text-rose-400 hover:text-rose-300 px-2 py-1 bg-rose-500/10 rounded-md"
                        >
                          Discontinue
                        </button>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right Column: Activity Timeline & Responses (2 Cols) */}
        <div className="lg:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
              <Activity className="w-4 h-4 text-teal-400" />
              <span>{t('timeline')} & Interaction History</span>
            </h3>
            <span className="text-xs text-slate-400">{timeline.length} events</span>
          </div>

          <div className="rounded-2xl bg-slate-900/80 border border-slate-800 p-6 space-y-6">
            {timeline.length === 0 ? (
              <p className="text-center text-xs text-slate-500 py-8">No recorded activity for this patient yet.</p>
            ) : (
              <div className="relative border-s border-slate-800 space-y-6 ps-6">
                {timeline.map((event, idx) => {
                  const isReminder = event.type === 'reminder';
                  const isResponse = event.type === 'patient_response';
                  const isCase = event.type === 'followup_case';
                  const isConsent = event.type === 'consent';

                  return (
                    <div key={idx} className="relative group">
                      {/* Timeline Node Icon */}
                      <div
                        className={`absolute -start-[31px] top-0 w-6 h-6 rounded-full border-2 flex items-center justify-center text-[10px] ${
                          isReminder
                            ? 'bg-slate-900 border-blue-500 text-blue-400'
                            : isResponse
                            ? event.status === 'problem'
                              ? 'bg-slate-900 border-rose-500 text-rose-400'
                              : event.status === 'missed'
                              ? 'bg-slate-900 border-amber-500 text-amber-400'
                              : 'bg-slate-900 border-emerald-500 text-emerald-400'
                            : isCase
                            ? 'bg-slate-900 border-purple-500 text-purple-400'
                            : 'bg-slate-900 border-slate-600 text-slate-400'
                        }`}
                      >
                        {isReminder ? 'R' : isResponse ? 'P' : isCase ? 'C' : 'S'}
                      </div>

                      {/* Event Card */}
                      <div className="p-4 rounded-xl bg-slate-800/40 border border-slate-800 hover:border-slate-700 transition-colors space-y-2">
                        <div className="flex items-center justify-between">
                          <h4 className="font-bold text-sm text-slate-100">{event.title}</h4>
                          <span className="text-[11px] text-slate-500 font-mono">
                            {new Date(event.timestamp).toLocaleString()}
                          </span>
                        </div>

                        {isReminder && (
                          <div className="text-xs text-slate-400 flex items-center gap-3">
                            <span>Status: <strong className="text-slate-200">{t(event.status)}</strong></span>
                            {event.details?.provider_message_id && (
                              <span className="font-mono text-[10px] text-slate-500 truncate max-w-[200px]">
                                ID: {event.details.provider_message_id}
                              </span>
                            )}
                            {event.details?.error && (
                              <span className="text-rose-400 font-medium">{event.details.error}</span>
                            )}
                          </div>
                        )}

                        {isResponse && (
                          <div className="text-xs space-y-1">
                            <p className="text-slate-200 bg-slate-950/60 p-2.5 rounded-lg border border-slate-800/80 font-medium">
                              "{event.details?.raw_content}"
                            </p>
                            <div className="flex items-center gap-2 text-[11px] text-slate-400">
                              <span>Classification: <strong className="text-emerald-400">{t(event.status)}</strong></span>
                              {event.details?.is_linked && (
                                <span className="text-teal-400">✓ Linked to reminder</span>
                              )}
                            </div>
                          </div>
                        )}

                        {isCase && (
                          <div className="text-xs text-slate-400 space-y-1">
                            <p>Priority: <strong className="text-amber-400">{event.priority}</strong> • Status: <strong className="text-slate-200">{event.status}</strong></p>
                            <p>Interventions documented: {event.details?.interventions_count}</p>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Withdraw Consent Confirmation Modal */}
      {showWithdrawModal && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4 z-50 animate-in fade-in">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-md p-6 space-y-5">
            <div className="flex items-center gap-3 text-rose-400">
              <Ban className="w-6 h-6" />
              <h3 className="text-base font-bold text-slate-100">Confirm Consent Withdrawal</h3>
            </div>
            <p className="text-xs text-slate-300 leading-relaxed">
              Withdrawing consent will pause patient enrollment and <strong>automatically cancel all future scheduled WhatsApp reminders</strong> immediately.
            </p>
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1">Reason for Withdrawal</label>
              <textarea
                rows={2}
                value={withdrawReason}
                onChange={(e) => setWithdrawReason(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl p-2.5 text-xs text-slate-200 focus:outline-none focus:border-rose-500"
              />
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => setShowWithdrawModal(false)}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold"
              >
                Cancel
              </button>
              <button
                onClick={handleWithdrawConsent}
                className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold shadow-md shadow-rose-900/30"
              >
                Withdraw & Cancel Reminders
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Medication Modal */}
      {showAddMedModal && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4 z-50 animate-in fade-in">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-lg p-6 space-y-5">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-bold text-slate-100 flex items-center gap-2">
                <Pill className="w-5 h-5 text-emerald-400" />
                <span>{t('addMedication')}</span>
              </h3>
              <button onClick={() => setShowAddMedModal(false)} className="text-slate-400">✕</button>
            </div>

            <form onSubmit={handleAddMedication} className="space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="block font-semibold text-slate-300 mb-1">Medication Trade / Generic Name *</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Concor (Bisoprolol)"
                    value={newMed.name}
                    onChange={(e) => setNewMed({ ...newMed, name: e.target.value })}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-slate-200 focus:outline-none focus:border-emerald-500"
                  />
                </div>

                <div>
                  <label className="block font-semibold text-slate-300 mb-1">Dose & Unit *</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      required
                      placeholder="e.g. 5"
                      value={newMed.dose}
                      onChange={(e) => setNewMed({ ...newMed, dose: e.target.value })}
                      className="w-2/3 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-slate-200"
                    />
                    <select
                      value={newMed.unit}
                      onChange={(e) => setNewMed({ ...newMed, unit: e.target.value })}
                      className="w-1/3 bg-slate-950 border border-slate-800 rounded-xl px-2 py-2 text-slate-200"
                    >
                      <option value="mg">mg</option>
                      <option value="g">g</option>
                      <option value="ml">ml</option>
                      <option value="tablet">tablet</option>
                      <option value="capsule">capsule</option>
                      <option value="puff">puff</option>
                      <option value="drop">drops</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block font-semibold text-slate-300 mb-1">Route</label>
                  <select
                    value={newMed.route}
                    onChange={(e) => setNewMed({ ...newMed, route: e.target.value })}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-slate-200"
                  >
                    <option value="oral">Oral (فموي)</option>
                    <option value="inhaled">Inhaled (استنشاق)</option>
                    <option value="topical">Topical (موضعي)</option>
                    <option value="ophthalmic">Eye Drops (قطرة عين)</option>
                    <option value="subcutaneous">Subcutaneous (تحت الجلد)</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block font-semibold text-slate-300 mb-1">Frequency Description</label>
                <input
                  type="text"
                  placeholder="e.g. Twice daily with meals"
                  value={newMed.frequency_description}
                  onChange={(e) => setNewMed({ ...newMed, frequency_description: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-slate-200"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-300 mb-1">
                  Scheduled Reminder Times (HH:MM 24-hour format, comma separated) *
                </label>
                <input
                  type="text"
                  required
                  placeholder="08:30, 20:30"
                  value={newMed.scheduled_times.join(', ')}
                  onChange={(e) =>
                    setNewMed({
                      ...newMed,
                      scheduled_times: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                    })
                  }
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-slate-200 font-mono"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-300 mb-1">Prescription Source / Reference</label>
                <input
                  type="text"
                  placeholder="e.g. Cardiology Outpatient Clinic - Dr. Hazem"
                  value={newMed.prescription_reference}
                  onChange={(e) => setNewMed({ ...newMed, prescription_reference: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-slate-200"
                />
              </div>

              <div className="flex justify-end gap-3 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowAddMedModal(false)}
                  className="px-4 py-2 rounded-xl bg-slate-800 text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold"
                >
                  Authorize Medication Schedule
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
