'use client';

import React, { useState } from 'react';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import { api } from '@/lib/api';
import {
  Menu,
  Globe,
  PlayCircle,
  CheckCircle2,
  RefreshCw,
  Bell,
  Search,
} from 'lucide-react';

interface HeaderProps {
  onMenuClick: () => void;
  onRefreshData?: () => void;
  onSearchChange?: (term: string) => void;
  searchTerm?: string;
}

export const Header: React.FC<HeaderProps> = ({
  onMenuClick,
  onRefreshData,
  onSearchChange,
  searchTerm = '',
}) => {
  const { language, setLanguage, t } = useLanguage();
  const { user } = useAuth();
  const [isTriggering, setIsTriggering] = useState(false);
  const [triggerResult, setTriggerResult] = useState<string | null>(null);

  const handleTriggerCycle = async () => {
    setIsTriggering(true);
    setTriggerResult(null);
    try {
      const res = await api.triggerReminderCycle();
      setTriggerResult(
        language === 'ar'
          ? `تم فحص التذكيرات: ${res.generated_count} جديدة، ${res.dispatch_summary?.sent || 0} مرسلة.`
          : `Processed: ${res.generated_count} generated, ${res.dispatch_summary?.sent || 0} sent.`
      );
      if (onRefreshData) onRefreshData();
      setTimeout(() => setTriggerResult(null), 6000);
    } catch (err: any) {
      setTriggerResult(err.message || 'Error triggering reminder cycle');
      setTimeout(() => setTriggerResult(null), 6000);
    } finally {
      setIsTriggering(false);
    }
  };

  return (
    <header className="sticky top-0 z-30 bg-slate-900/80 backdrop-blur-md border-b border-slate-800/80 px-6 py-3.5 flex items-center justify-between gap-4">
      {/* Mobile Toggle & Search */}
      <div className="flex items-center gap-4 flex-1 max-w-xl">
        <button
          onClick={onMenuClick}
          className="p-2 text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded-xl lg:hidden transition-colors"
        >
          <Menu className="w-5 h-5" />
        </button>

        <div className="relative w-full max-w-md hidden sm:block">
          <Search className="w-4 h-4 text-slate-400 absolute start-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder={t('searchPlaceholder')}
            value={searchTerm}
            onChange={(e) => onSearchChange && onSearchChange(e.target.value)}
            className="w-full bg-slate-950/60 border border-slate-800 rounded-xl py-2 ps-10 pe-4 text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/30 transition-all"
          />
        </div>
      </div>

      {/* Right Controls */}
      <div className="flex items-center gap-3">
        {/* Trigger Reminder Cycle Button */}
        <button
          onClick={handleTriggerCycle}
          disabled={isTriggering}
          className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-medium text-xs shadow-md shadow-emerald-900/20 transition-all disabled:opacity-50"
          title="Executes the backend engine to check due schedules and dispatch WhatsApp templates immediately"
        >
          {isTriggering ? (
            <RefreshCw className="w-4 h-4 animate-spin" />
          ) : (
            <PlayCircle className="w-4 h-4" />
          )}
          <span className="hidden md:inline">{t('triggerCycle')}</span>
        </button>

        {/* Language Switcher */}
        <button
          onClick={() => setLanguage(language === 'ar' ? 'en' : 'ar')}
          className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-800/80 hover:bg-slate-800 border border-slate-700/60 text-slate-300 font-medium text-xs transition-all"
          title="Toggle Arabic / English"
        >
          <Globe className="w-4 h-4 text-teal-400" />
          <span>{language === 'ar' ? 'English' : 'العربية'}</span>
        </button>
      </div>

      {/* Trigger Notification Banner */}
      {triggerResult && (
        <div className="absolute top-16 start-6 end-6 bg-slate-800 border border-emerald-500/40 text-emerald-300 px-4 py-3 rounded-xl shadow-xl flex items-center gap-3 z-50 text-sm animate-in fade-in slide-in-from-top-2">
          <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
          <span className="flex-1">{triggerResult}</span>
          <button
            onClick={() => setTriggerResult(null)}
            className="text-xs px-2 py-1 bg-slate-700/60 hover:bg-slate-700 rounded-md text-slate-300"
          >
            ✕
          </button>
        </div>
      )}
    </header>
  );
};
