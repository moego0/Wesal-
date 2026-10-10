'use client';

import React, { useState, useEffect } from 'react';
import { LanguageProvider, useLanguage } from '@/context/LanguageContext';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import { DashboardStats } from '@/lib/types';
import { api } from '@/lib/api';

import { Sidebar } from '@/components/Sidebar';
import { Header } from '@/components/Header';
import { LoginModal } from '@/components/LoginModal';

import { DashboardView } from '@/components/views/DashboardView';
import { PatientsView } from '@/components/views/PatientsView';
import { PatientDetailView } from '@/components/views/PatientDetailView';
import { MedicationsView } from '@/components/views/MedicationsView';
import { RemindersView } from '@/components/views/RemindersView';
import { FollowUpsView } from '@/components/views/FollowUpsView';
import { WhatsAppSimulatorView } from '@/components/views/WhatsAppSimulatorView';
import { ReportsView } from '@/components/views/ReportsView';
import { AuditLogsView } from '@/components/views/AuditLogsView';
import { SettingsView } from '@/components/views/SettingsView';

function WesalApp() {
  const { isRTL } = useLanguage();
  const { user, isLoading: isAuthLoading } = useAuth();

  const [currentTab, setCurrentTab] = useState('dashboard');
  const [selectedPatientId, setSelectedPatientId] = useState<string | null>(null);
  const [simulatorPhone, setSimulatorPhone] = useState<string | null>(null);
  const [followUpFilter, setFollowUpFilter] = useState<string | undefined>();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');

  const [stats, setStats] = useState<DashboardStats | null>(null);

  const fetchStats = async () => {
    if (!user) return;
    try {
      const data = await api.getDashboardStats();
      setStats(data);
    } catch (err) {
      console.error('Error fetching dashboard statistics:', err);
    }
  };

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 20000); // 20s live polling
    return () => clearInterval(interval);
  }, [user]);

  const handleNavigate = (tab: string, filter?: string) => {
    if (tab === 'followups' && filter) {
      setFollowUpFilter(filter);
    }
    setCurrentTab(tab);
    setSelectedPatientId(null);
  };

  const handleSelectPatient = (patientId: string) => {
    setSelectedPatientId(patientId);
    setCurrentTab('patient_detail');
  };

  const handleNavigateToSimulator = (phone: string) => {
    setSimulatorPhone(phone);
    setCurrentTab('simulator');
  };

  if (isAuthLoading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center text-slate-300">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-4 border-emerald-500/20 border-t-emerald-500 rounded-full animate-spin" />
          <p className="text-sm font-medium">Initializing Wesal Platform...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <LoginModal />;
  }

  return (
    <div className={`min-h-screen bg-slate-950 text-slate-100 flex ${isRTL ? 'font-sans' : ''}`}>
      {/* Sidebar Navigation */}
      <Sidebar
        currentTab={currentTab}
        setCurrentTab={(tab) => {
          setCurrentTab(tab);
          if (tab !== 'patient_detail') setSelectedPatientId(null);
        }}
        isMobileOpen={isMobileMenuOpen}
        setIsMobileOpen={setIsMobileMenuOpen}
      />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        <Header
          onMenuClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
          onRefreshData={fetchStats}
          onSearchChange={setSearchTerm}
          searchTerm={searchTerm}
        />

        <main className="flex-1 p-6 lg:p-8 max-w-7xl w-full mx-auto">
          {currentTab === 'dashboard' && (
            <DashboardView
              stats={stats}
              onNavigate={handleNavigate}
              onSelectPatient={handleSelectPatient}
            />
          )}

          {currentTab === 'patients' && (
            <PatientsView
              onSelectPatient={handleSelectPatient}
              searchTerm={searchTerm}
            />
          )}

          {currentTab === 'patient_detail' && selectedPatientId && (
            <PatientDetailView
              patientId={selectedPatientId}
              onBack={() => setCurrentTab('patients')}
              onNavigateToSimulator={handleNavigateToSimulator}
            />
          )}

          {currentTab === 'medications' && (
            <MedicationsView onSelectPatient={handleSelectPatient} />
          )}

          {currentTab === 'reminders' && (
            <RemindersView onSelectPatient={handleSelectPatient} />
          )}

          {currentTab === 'followups' && (
            <FollowUpsView
              initialFilter={followUpFilter}
              onSelectPatient={handleSelectPatient}
            />
          )}

          {currentTab === 'simulator' && (
            <WhatsAppSimulatorView
              initialPhone={simulatorPhone || undefined}
              onSelectPatient={handleSelectPatient}
            />
          )}

          {currentTab === 'reports' && <ReportsView stats={stats} />}

          {currentTab === 'audit' && <AuditLogsView />}

          {currentTab === 'settings' && <SettingsView />}
        </main>
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <LanguageProvider>
      <AuthProvider>
        <WesalApp />
      </AuthProvider>
    </LanguageProvider>
  );
}
