'use client';

import React, { useState, useEffect } from 'react';
import { useLanguage } from '@/context/LanguageContext';
import { Patient } from '@/lib/types';
import { api } from '@/lib/api';
import {
  Users,
  UserPlus,
  Search,
  CheckCircle2,
  AlertCircle,
  Phone,
  Pill,
  Calendar,
  ChevronRight,
  ShieldCheck,
  Ban,
  RefreshCw,
  Plus,
  Send,
} from 'lucide-react';

interface PatientsViewProps {
  onSelectPatient: (patientId: string) => void;
  searchTerm?: string;
}

export const PatientsView: React.FC<PatientsViewProps> = ({
  onSelectPatient,
  searchTerm: initialSearch = '',
}) => {
  const { t, isRTL } = useLanguage();
  const [patients, setPatients] = useState<Patient[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [filterConsent, setFilterConsent] = useState('');
  const [filterEnrollment, setFilterEnrollment] = useState('');
  const [search, setSearch] = useState(initialSearch);

  // Add Patient Modal State
  const [showAddModal, setShowAddModal] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [newPatient, setNewPatient] = useState<{
    full_name: string;
    phone_number: string;
    preferred_language: 'ar' | 'en';
    consent_method: string;
    consent_scope: string;
    notes: string;
  }>({
    full_name: '',
    phone_number: '+2010',
    preferred_language: 'ar',
    consent_method: 'verbal_in_person',
    consent_scope: 'WhatsApp medication reminders & adherence follow-up',
    notes: '',
  });

  const loadPatients = async () => {
    setIsLoading(true);
    try {
      const params: Record<string, string> = {};
      if (search) params.search = search;
      if (filterConsent) params.consent_status = filterConsent;
      if (filterEnrollment) params.enrollment_status = filterEnrollment;

      const res = await api.getPatients(params);
      setPatients(res.results || []);
    } catch (err) {
      console.error('Error loading patients:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadPatients();
  }, [filterConsent, filterEnrollment, search]);

  const handleCreatePatient = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      const created = await api.createPatient(newPatient);
      setShowAddModal(false);
      setNewPatient({
        full_name: '',
        phone_number: '+2010',
        preferred_language: 'ar',
        consent_method: 'verbal_in_person',
        consent_scope: 'WhatsApp medication reminders & adherence follow-up',
        notes: '',
      });
      loadPatients();
      onSelectPatient(created.id);
    } catch (err: any) {
      alert(`Error adding patient: ${err.message}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      {/* Header and Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <Users className="w-5 h-5 text-emerald-400" />
            <span>{t('patients')}</span>
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Manage enrolled patients, verify consent status, and configure treatment schedules.
          </p>
        </div>

        <button
          onClick={() => setShowAddModal(true)}
          className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white text-xs font-semibold shadow-lg shadow-emerald-900/20 flex items-center gap-2 transition-all self-start sm:self-auto"
        >
          <UserPlus className="w-4 h-4" />
          <span>{t('addPatient')}</span>
        </button>
      </div>

      {/* Filter Bar */}
      <div className="p-4 rounded-2xl bg-slate-900/80 border border-slate-800 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 text-slate-400 absolute start-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder={t('searchPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-slate-950/60 border border-slate-800 rounded-xl py-2 ps-10 pe-4 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-emerald-500/50"
          />
        </div>

        <select
          value={filterConsent}
          onChange={(e) => setFilterConsent(e.target.value)}
          className="bg-slate-950/60 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-300 focus:outline-none focus:border-emerald-500/50"
        >
          <option value="">All Consent Statuses</option>
          <option value="consented">{t('consented')}</option>
          <option value="withdrawn">{t('withdrawn')}</option>
          <option value="pending">{t('pending')}</option>
        </select>

        <select
          value={filterEnrollment}
          onChange={(e) => setFilterEnrollment(e.target.value)}
          className="bg-slate-950/60 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-300 focus:outline-none focus:border-emerald-500/50"
        >
          <option value="">All Enrollment Statuses</option>
          <option value="active">{t('active')}</option>
          <option value="paused">{t('paused')}</option>
          <option value="discharged">{t('completed')}</option>
        </select>

        <button
          onClick={loadPatients}
          title="Refresh List"
          className="p-2 bg-slate-800 hover:bg-slate-700 rounded-xl text-slate-300 transition-colors"
        >
          <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Patients Table / Grid */}
      <div className="rounded-2xl bg-slate-900/80 border border-slate-800 overflow-hidden shadow-xl">
        <div className="overflow-x-auto">
          <table className="w-full text-start text-xs">
            <thead className="bg-slate-950/60 border-b border-slate-800 text-slate-400 font-semibold uppercase tracking-wider">
              <tr>
                <th className="px-5 py-3.5 text-start">{t('patientCode')} & Name</th>
                <th className="px-5 py-3.5 text-start">{t('phone')}</th>
                <th className="px-5 py-3.5 text-start">{t('consentStatus')}</th>
                <th className="px-5 py-3.5 text-start">{t('enrollmentStatus')}</th>
                <th className="px-5 py-3.5 text-start">{t('responsiblePharmacist')}</th>
                <th className="px-5 py-3.5 text-end">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 text-slate-300">
              {isLoading ? (
                <tr>
                  <td colSpan={6} className="px-5 py-12 text-center text-slate-400">
                    <div className="flex justify-center items-center gap-2">
                      <RefreshCw className="w-4 h-4 animate-spin text-emerald-400" />
                      <span>Loading patients roster...</span>
                    </div>
                  </td>
                </tr>
              ) : patients.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-5 py-12 text-center text-slate-500 space-y-2">
                    <Users className="w-8 h-8 mx-auto opacity-50 text-slate-400" />
                    <p className="font-semibold text-slate-400">No patients found</p>
                    <p className="text-[11px] text-slate-500">Try adjusting your search or filters.</p>
                  </td>
                </tr>
              ) : (
                patients.map((patient) => {
                  const isConsented = patient.consent_status === 'consented';
                  const isActive = patient.enrollment_status === 'active';

                  return (
                    <tr
                      key={patient.id}
                      onClick={() => onSelectPatient(patient.id)}
                      className="hover:bg-slate-800/40 transition-colors cursor-pointer group"
                    >
                      {/* Name & Code */}
                      <td className="px-5 py-4">
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-xl bg-slate-800 border border-slate-700/60 flex items-center justify-center font-bold text-slate-200 group-hover:border-emerald-500/40 transition-colors">
                            {patient.full_name.charAt(0)}
                          </div>
                          <div>
                            <p className="font-bold text-slate-100 group-hover:text-emerald-300 transition-colors text-sm">
                              {patient.full_name}
                            </p>
                            <span className="text-[11px] font-mono text-slate-400">
                              {patient.patient_code}
                            </span>
                          </div>
                        </div>
                      </td>

                      {/* Phone */}
                      <td className="px-5 py-4 font-mono text-slate-300">
                        <div className="flex items-center gap-1.5">
                          <Phone className="w-3.5 h-3.5 text-emerald-400" />
                          <span dir="ltr">{patient.phone_number}</span>
                        </div>
                      </td>

                      {/* Consent Status Badge */}
                      <td className="px-5 py-4">
                        <span
                          className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold border ${
                            isConsented
                              ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                              : patient.consent_status === 'withdrawn'
                              ? 'bg-rose-500/10 text-rose-400 border-rose-500/20'
                              : 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                          }`}
                        >
                          {isConsented ? (
                            <CheckCircle2 className="w-3 h-3" />
                          ) : (
                            <Ban className="w-3 h-3" />
                          )}
                          <span>{t(patient.consent_status)}</span>
                        </span>
                      </td>

                      {/* Enrollment */}
                      <td className="px-5 py-4">
                        <span
                          className={`inline-flex items-center px-2.5 py-0.5 rounded-md text-[11px] font-medium ${
                            isActive
                              ? 'bg-teal-500/10 text-teal-300'
                              : 'bg-slate-800 text-slate-400'
                          }`}
                        >
                          {t(patient.enrollment_status)}
                        </span>
                      </td>

                      {/* Responsible Pharmacist */}
                      <td className="px-5 py-4 text-slate-400">
                        {patient.responsible_pharmacist_name || 'Assigned Staff'}
                      </td>

                      {/* Arrow */}
                      <td className="px-5 py-4 text-end">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectPatient(patient.id);
                          }}
                          className="p-1.5 rounded-lg bg-slate-800 text-slate-400 group-hover:text-emerald-300 group-hover:bg-emerald-500/10 transition-colors"
                        >
                          <ChevronRight className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add Patient Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4 z-50 animate-in fade-in duration-200">
          <div className="bg-slate-900 border border-slate-700/80 rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl space-y-6 p-6">
            <div className="flex items-center justify-between border-b border-slate-800 pb-4">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center">
                  <UserPlus className="w-5 h-5" />
                </div>
                <h3 className="text-base font-bold text-slate-100">{t('addPatient')}</h3>
              </div>
              <button
                onClick={() => setShowAddModal(false)}
                className="text-slate-400 hover:text-slate-200 text-lg"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleCreatePatient} className="space-y-4 text-xs">
              <div>
                <label className="block text-slate-300 font-semibold mb-1">{t('fullName')} *</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Ahmed Mahmoud (أحمد محمود)"
                  value={newPatient.full_name}
                  onChange={(e) => setNewPatient({ ...newPatient, full_name: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-slate-200 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">{t('phone')} (Egypt / International) *</label>
                <input
                  type="tel"
                  required
                  placeholder="+201012345678"
                  value={newPatient.phone_number}
                  onChange={(e) => setNewPatient({ ...newPatient, phone_number: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-slate-200 font-mono focus:outline-none focus:border-emerald-500"
                />
                <p className="text-[11px] text-slate-500 mt-1">Normalized to +20 (E.164 format) automatically.</p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-300 font-semibold mb-1">{t('preferredLang')}</label>
                  <select
                    value={newPatient.preferred_language}
                    onChange={(e) => setNewPatient({ ...newPatient, preferred_language: e.target.value as any })}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2.5 text-slate-200 focus:outline-none focus:border-emerald-500"
                  >
                    <option value="ar">العربية (Arabic)</option>
                    <option value="en">English</option>
                  </select>
                </div>

                <div>
                  <label className="block text-slate-300 font-semibold mb-1">Consent Method</label>
                  <select
                    value={newPatient.consent_method}
                    onChange={(e) => setNewPatient({ ...newPatient, consent_method: e.target.value })}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2.5 text-slate-200 focus:outline-none focus:border-emerald-500"
                  >
                    <option value="verbal_in_person">Verbal in Pharmacy (شفهي بالصيدلية)</option>
                    <option value="written_form">Signed Consent Form (نموذج موقع)</option>
                    <option value="digital_opt_in">WhatsApp Digital Opt-In</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">Clinical Notes (Optional)</label>
                <textarea
                  rows={2}
                  placeholder="e.g. Hypertension, prefers evening reminders"
                  value={newPatient.notes}
                  onChange={(e) => setNewPatient({ ...newPatient, notes: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-slate-200 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div className="pt-4 flex items-center justify-end gap-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-md shadow-emerald-900/30 transition-colors disabled:opacity-50"
                >
                  {isSubmitting ? 'Saving...' : 'Register Patient & Consent'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
