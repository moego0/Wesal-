'use client';

import React, { useState, useEffect } from 'react';
import { useLanguage } from '@/context/LanguageContext';
import { AuditEvent } from '@/lib/types';
import { api } from '@/lib/api';
import {
  ShieldCheck,
  Search,
  RefreshCw,
  Clock,
  User,
  Activity,
  Key,
} from 'lucide-react';

export const AuditLogsView: React.FC = () => {
  const { t, isRTL } = useLanguage();
  const [logs, setLogs] = useState<AuditEvent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState('');

  const loadAuditLogs = async () => {
    setIsLoading(true);
    try {
      const params: Record<string, string> = {};
      if (search) params.action = search;
      const res = await api.getAuditLogs(params);
      setLogs(res.results || []);
    } catch (err) {
      console.error('Error loading audit logs:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadAuditLogs();
  }, [search]);

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-emerald-400" />
            <span>{t('auditLogs')} & Security Trail</span>
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Immutable log of all clinical actions, consent changes, schedule updates, and system events.
          </p>
        </div>

        <button
          onClick={loadAuditLogs}
          className="p-2 bg-slate-800 hover:bg-slate-700 rounded-xl text-slate-300 transition-colors self-start sm:self-auto"
        >
          <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Table */}
      <div className="rounded-2xl bg-slate-900/80 border border-slate-800 overflow-hidden shadow-xl">
        <div className="overflow-x-auto">
          <table className="w-full text-start text-xs">
            <thead className="bg-slate-950/60 border-b border-slate-800 text-slate-400 font-semibold uppercase tracking-wider">
              <tr>
                <th className="px-5 py-3.5 text-start">Timestamp</th>
                <th className="px-5 py-3.5 text-start">Action</th>
                <th className="px-5 py-3.5 text-start">Entity Type & ID</th>
                <th className="px-5 py-3.5 text-start">User / Pharmacist</th>
                <th className="px-5 py-3.5 text-start">Metadata / Changes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 text-slate-300">
              {isLoading ? (
                <tr>
                  <td colSpan={5} className="px-5 py-12 text-center text-slate-400">
                    <RefreshCw className="w-5 h-5 animate-spin mx-auto text-emerald-400 mb-2" />
                    <span>Loading audit records...</span>
                  </td>
                </tr>
              ) : logs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-5 py-12 text-center text-slate-500">
                    No audit records logged yet.
                  </td>
                </tr>
              ) : (
                logs.map((log) => (
                  <tr key={log.id} className="hover:bg-slate-800/40 transition-colors font-mono">
                    <td className="px-5 py-3.5 text-slate-400 text-[11px]">
                      {new Date(log.created_at).toLocaleString()}
                    </td>
                    <td className="px-5 py-3.5">
                      <span className="px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 font-semibold text-[11px]">
                        {log.action}
                      </span>
                    </td>
                    <td className="px-5 py-3.5 text-slate-300">
                      {log.entity_type} {log.entity_id && `(#${log.entity_id.slice(0, 8)})`}
                    </td>
                    <td className="px-5 py-3.5 text-slate-200 font-sans">
                      {log.user_name || 'System Engine'}
                    </td>
                    <td className="px-5 py-3.5 text-[11px] text-slate-400 truncate max-w-[280px]">
                      {JSON.stringify(log.metadata)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
