'use client';

import React, { createContext, useContext, useState, useEffect } from 'react';

type Language = 'ar' | 'en';

interface Translations {
  [key: string]: {
    ar: string;
    en: string;
  };
}

export const translations: Translations = {
  // Brand & Header
  appName: { ar: 'وِصال', en: 'Wesal' },
  appTagline: { ar: 'منصة متابعة الأدوية والتواصل الصيدلاني الذكي', en: 'Medication Follow-Up & WhatsApp Adherence Platform' },
  dashboard: { ar: 'لوحة التحكم', en: 'Dashboard' },
  patients: { ar: 'المرضى', en: 'Patients' },
  medications: { ar: 'الأدوية والجرعات', en: 'Medications' },
  reminders: { ar: 'سجل التذكيرات', en: 'Reminders' },
  followups: { ar: 'حالات المتابعة والتدخل', en: 'Follow-Up Cases' },
  simulator: { ar: 'محاكي واتساب التفاعلي', en: 'WhatsApp Simulator' },
  reports: { ar: 'التقارير والإحصائيات', en: 'Reports & Export' },
  auditLogs: { ar: 'سجل التدقيق والأمان', en: 'Audit Logs' },
  settings: { ar: 'الإعدادات والربط', en: 'Settings' },
  logout: { ar: 'تسجيل الخروج', en: 'Sign Out' },
  login: { ar: 'تسجيل الدخول', en: 'Sign In' },
  email: { ar: 'البريد الإلكتروني', en: 'Email' },
  password: { ar: 'كلمة المرور', en: 'Password' },
  welcome: { ar: 'مرحباً بك، دكتور', en: 'Welcome, Dr.' },

  // Stats
  totalEnrolled: { ar: 'إجمالي المرضى المسجلين', en: 'Total Enrolled Patients' },
  activePatients: { ar: 'المرضى النشطون', en: 'Active Patients' },
  remindersToday: { ar: 'تذكيرات اليوم', en: 'Reminders Today' },
  deliveredReminders: { ar: 'تم التسليم بنجاح', en: 'Delivered Successfully' },
  deliveryRate: { ar: 'معدل التسليم', en: 'Delivery Rate' },
  responseRate: { ar: 'معدل الاستجابة', en: 'Response Rate' },
  missedReports: { ar: 'مرضى أبلغوا عن تفويت جرعة', en: 'Patients Reporting Missed Doses' },
  problemReports: { ar: 'شكاوى ومشاكل دوائية', en: 'Medication Problem Reports' },
  followupsDue: { ar: 'متابعات مستحقة اليوم', en: 'Follow-Ups Due Today' },
  overdueCases: { ar: 'متابعات متأخرة', en: 'Overdue Follow-Ups' },
  openCases: { ar: 'حالات مفتوحة', en: 'Open Cases' },
  urgentAlerts: { ar: 'تنبيهات عاجلة', en: 'Urgent Alerts' },

  // Quick Actions
  triggerCycle: { ar: 'تشغيل دورة الإرسال الآن', en: 'Run Dispatch Cycle Now' },
  addPatient: { ar: 'تسجيل مريض جديد', en: 'Add New Patient' },
  addMedication: { ar: 'إضافة دواء وجدول جرعات', en: 'Add Medication Schedule' },
  exportCsv: { ar: 'تصدير كملف CSV', en: 'Export CSV' },
  searchPlaceholder: { ar: 'بحث بالاسم، رقم الهاتف، أو كود المريض...', en: 'Search by name, phone, or patient code...' },

  // Patient Details
  patientCode: { ar: 'كود المريض', en: 'Patient Code' },
  fullName: { ar: 'الاسم الكامل', en: 'Full Name' },
  phone: { ar: 'رقم الواتساب', en: 'WhatsApp Number' },
  consentStatus: { ar: 'حالة الموافقة', en: 'Consent Status' },
  enrollmentStatus: { ar: 'حالة الاشتراك', en: 'Enrollment Status' },
  preferredLang: { ar: 'اللغة المفضلة', en: 'Preferred Language' },
  responsiblePharmacist: { ar: 'الصيدلي المسؤول', en: 'Responsible Pharmacist' },
  activeMedications: { ar: 'الأدوية النشطة', en: 'Active Medications' },
  timeline: { ar: 'الخط الزمني للنشاط', en: 'Activity Timeline' },
  withdrawConsent: { ar: 'سحب الموافقة وإيقاف الرسائل', en: 'Withdraw Consent' },
  renewConsent: { ar: 'تجديد الموافقة', en: 'Renew Consent' },

  // Statuses
  consented: { ar: 'موافق ونشط', en: 'Consented' },
  withdrawn: { ar: 'تم سحب الموافقة', en: 'Withdrawn' },
  pending: { ar: 'قيد الانتظار', en: 'Pending' },
  active: { ar: 'نشط', en: 'Active' },
  paused: { ar: 'موقوف مؤقتاً', en: 'Paused' },
  discontinued: { ar: 'ملغي / متوقف', en: 'Discontinued' },
  completed: { ar: 'مكتمل', en: 'Completed' },

  // Reminder Statuses
  scheduled: { ar: 'مجدول', en: 'Scheduled' },
  queued: { ar: 'في قائمة الانتظار', en: 'Queued' },
  submitted: { ar: 'تم الإرسال للمزود', en: 'Submitted' },
  sent: { ar: 'مرسل', en: 'Sent' },
  delivered: { ar: 'تم الاستلام في الجهاز', en: 'Delivered' },
  read: { ar: 'تمت القراءة', en: 'Read' },
  responded: { ar: 'تم الرد من المريض', en: 'Responded' },
  failed: { ar: 'فشل الإرسال', en: 'Failed' },
  cancelled: { ar: 'ملغي', en: 'Cancelled' },

  // Response Categories
  taken: { ar: 'تم أخذ الدواء', en: 'Taken' },
  takenLate: { ar: 'أخذته متأخراً', en: 'Taken Late' },
  missed: { ar: 'لم آخذه', en: 'Missed' },
  remindLater: { ar: 'ذكّرني لاحقاً', en: 'Remind Later' },
  problem: { ar: 'مشكلة مع الدواء', en: 'Medication Problem' },
  unknown: { ar: 'رد غير معروف', en: 'Unknown Response' },

  // Follow-up Priorities
  urgent: { ar: 'عاجل جداً', en: 'Urgent' },
  high: { ar: 'مرتفع', en: 'High' },
  medium: { ar: 'متوسط', en: 'Medium' },
  low: { ar: 'منخفض', en: 'Low' },

  // Follow-up Actions
  recordIntervention: { ar: 'توثيق تدخل صيدلاني', en: 'Record Intervention' },
  closeCase: { ar: 'إغلاق الحالة', en: 'Close Case' },
  contactAttempted: { ar: 'تمت محاولة التواصل', en: 'Contact Attempted' },
  contactMethod: { ar: 'وسيلة التواصل', en: 'Contact Method' },
  patientReason: { ar: 'السبب المذكور من المريض', en: 'Patient Reported Reason' },
  actionTaken: { ar: 'الإجراء الصيدلاني المتخذ', en: 'Action Taken' },
  referralIndicated: { ar: 'توجيه لمراجعة الطبيب المعالج', en: 'Referral to Prescribing Doctor' },
  nextFollowUpDate: { ar: 'تاريخ المتابعة القادمة', en: 'Next Follow-Up Date' },
};

interface LanguageContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (key: string) => string;
  isRTL: boolean;
}

const LanguageContext = createContext<LanguageContextType>({
  language: 'ar',
  setLanguage: () => {},
  t: (key) => key,
  isRTL: true,
});

export const LanguageProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [language, setLanguageState] = useState<Language>('ar');

  useEffect(() => {
    const savedLang = localStorage.getItem('wesal_language') as Language;
    if (savedLang && (savedLang === 'ar' || savedLang === 'en')) {
      setLanguageState(savedLang);
    }
  }, []);

  const setLanguage = (lang: Language) => {
    setLanguageState(lang);
    localStorage.setItem('wesal_language', lang);
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    document.documentElement.lang = lang;
  };

  const t = (key: string): string => {
    if (translations[key] && translations[key][language]) {
      return translations[key][language];
    }
    return key;
  };

  const isRTL = language === 'ar';

  return (
    <LanguageContext.Provider value={{ language, setLanguage, t, isRTL }}>
      {children}
    </LanguageContext.Provider>
  );
};

export const useLanguage = () => useContext(LanguageContext);
