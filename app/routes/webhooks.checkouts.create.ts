import { useEffect, useState, useCallback } from 'react';
import {
  BarChart3,
  TrendingUp,
  Calendar,
  Users,
  CreditCard,
  RefreshCw,
  Clock3,
  Wallet,
  XCircle,
} from 'lucide-react';
import { useOrg } from '../contexts/OrgContext';
import { TopBar } from '../layout/TopBar';
import { PageLoader } from '../components/ui/Spinner';
import { getPayments } from '../lib/queries/payments';
import { getAppointmentsByDateRange } from '../lib/queries/appointments';
import { getCustomers } from '../lib/queries/customers';
import type { Payment, Appointment, AppointmentStatus } from '../types';
import { FormField, Input } from '../components/ui/FormField';
import { EmptyState } from '../components/ui/EmptyState';

const STATUS_LABELS: Record<AppointmentStatus, string> = {
  pending: 'Σε αναμονή',
  confirmed: 'Επιβεβαιωμένα',
  arrived: 'Άφιξη',
  in_service: 'Σε εξέλιξη',
  completed: 'Ολοκληρωμένα',
  canceled: 'Ακυρωμένα',
  no_show: 'Δεν προσήλθε',
};

function getLocalDateString(offsetDays = 0) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);

  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');

  return `${y}-${m}-${day}`;
}

function formatDateLabel(date: string) {
  if (!date) return '—';

  return new Date(`${date}T12:00:00`).toLocaleDateString('el-GR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function formatDayLabel(date: string) {
  if (!date) return '—';

  return new Date(`${date}T12:00:00`).toLocaleDateString('el-GR', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

function formatMethodLabel(method?: string | null) {
  const key = String(method ?? '').toLowerCase();

  if (key === 'cash') return 'Μετρητά';
  if (key === 'card') return 'Κάρτα';
  if (key === 'bank_transfer') return 'Τραπεζική μεταφορά';
  if (key === 'pos') return 'POS';
  if (!key) return 'Άγνωστο';

  return key.replaceAll('_', ' ');
}

function groupByDay(
  items: { created_at?: string; start_at?: string }[],
  key: 'created_at' | 'start_at',
) {
  const map: Record<string, number> = {};

  for (const item of items) {
    const date = (item[key] ?? '').split('T')[0];
    if (!date) continue;
    map[date] = (map[date] || 0) + 1;
  }

  return map;
}

function StatRow({
  label,
  value,
  sub,
}: {
  label: string;
  value: string | number;
  sub?: string;
}) {
  return (
    <div className="flex items-center justify-between py-3 border-b border-charcoal-50 last:border-0 gap-4">
      <span className="text-sm text-charcoal-600">{label}</span>

      <div className="text-right">
        <span className="text-sm font-semibold text-charcoal-900">{value}</span>
        {sub && <p className="text-xs text-charcoal-400 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

function MetricCard({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  sub?: string;
}) {
  return (
    <div className="luxury-card">
      <div className="flex items-start justify-between mb-4">
        <div className="w-11 h-11 rounded-2xl bg-charcoal-100 flex items-center justify-center">
          {icon}
        </div>
      </div>

      <p className="text-3xl font-semibold text-charcoal-900">{value}</p>
      <p className="text-xs text-charcoal-500 mt-1 font-medium uppercase tracking-wider">
        {label}
      </p>
      {sub && <p className="text-xs text-charcoal-400 mt-1">{sub}</p>}
    </div>
  );
}

function PresetButton({
  active,
  label,
  onClick,
}: {
  active?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
        active
          ? 'border-charcoal-800 bg-charcoal-900 text-white'
          : 'border-charcoal-200 text-charcoal-600 hover:border-charcoal-300 hover:text-charcoal-800'
      }`}
    >
      {label}
    </button>
  );
}

export default function Reports() {
  const { selectedOrgId } = useOrg();

  const [from, setFrom] = useState(getLocalDateString(-29));
  const [to, setTo] = useState(getLocalDateString(0));
  const [loading, setLoading] = useState(true);

  const [payments, setPayments] = useState<Payment[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [customerCount, setCustomerCount] = useState(0);

  const isRangeInvalid = !!from && !!to && from > to;

  const load = useCallback(async () => {
    if (!selectedOrgId || isRangeInvalid) {
      setLoading(false);
      return;
    }

    setLoading(true);

    try {
      const [pmts, appts, custs] = await Promise.all([
        getPayments(selectedOrgId, { from, to }),
        getAppointmentsByDateRange(
          selectedOrgId,
          `${from}T00:00:00`,
          `${to}T23:59:59`,
        ),
        getCustomers(selectedOrgId),
      ]);

      const sortedAppointments = [...appts].sort(
        (a, b) =>
          new Date(b.start_at).getTime() - new Date(a.start_at).getTime(),
      );

      setPayments(pmts);
      setAppointments(sortedAppointments);
      setCustomerCount(custs.length);
    } finally {
      setLoading(false);
    }
  }, [selectedOrgId, from, to, isRangeInvalid]);

  useEffect(() => {
    void load();
  }, [load]);

  const paidPayments = payments.filter((p) => p.status === 'paid');
  const pendingPayments = payments.filter((p) => p.status !== 'paid');

  const collectedRevenue = paidPayments.reduce(
    (sum, p) => sum + Number(p.amount ?? 0),
    0,
  );

  const validAppointments = appointments.filter(
    (a) => a.status !== 'canceled' && a.status !== 'no_show',
  );

  const bookedValue = validAppointments.reduce(
    (sum, a) => sum + Number(a.total_price ?? 0),
    0,
  );

  const avgCollectedPerPayment =
    paidPayments.length > 0 ? collectedRevenue / paidPayments.length : 0;

  const avgPerAppointment =
    validAppointments.length > 0 ? bookedValue / validAppointments.length : 0;

  const completedAppts = appointments.filter((a) => a.status === 'completed').length;
  const canceledAppts = appointments.filter((a) => a.status === 'canceled').length;
  const noShowAppts = appointments.filter((a) => a.status === 'no_show').length;
  const pendingAppts = appointments.filter((a) => a.status === 'pending').length;
  const confirmedAppts = appointments.filter((a) => a.status === 'confirmed').length;
  const inServiceAppts = appointments.filter(
    (a) => a.status === 'in_service' || a.status === 'arrived',
  ).length;

  const cancellationRate =
    appointments.length > 0
      ? ((canceledAppts + noShowAppts) / appointments.length) * 100
      : 0;

  const completionRate =
    appointments.length > 0 ? (completedAppts / appointments.length) * 100 : 0;

  const revenueByMethod = paidPayments.reduce((acc, p) => {
    const key = String(p.method ?? 'unknown');
    acc[key] = (acc[key] || 0) + Number(p.amount ?? 0);
    return acc;
  }, {} as Record<string, number>);

  const paymentMethods = Object.entries(revenueByMethod).sort(
    (a, b) => b[1] - a[1],
  );

  const topDays = Object.entries(groupByDay(appointments, 'start_at'))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  const topDayCount = topDays[0]?.[1] ?? 1;

  const activeCustomersInPeriod = new Set(
    appointments.map((a) => a.customer_id).filter(Boolean),
  ).size;

  const selectedDays =
    Math.floor(
      (new Date(`${to}T12:00:00`).getTime() -
        new Date(`${from}T12:00:00`).getTime()) /
        86400000,
    ) + 1;

  const setPreset = (days: number) => {
    setFrom(getLocalDateString(-(days - 1)));
    setTo(getLocalDateString(0));
  };

  const isPresetActive = (days: number) =>
    from === getLocalDateString(-(days - 1)) && to === getLocalDateString(0);

  const hasAnyData =
    payments.length > 0 || appointments.length > 0 || customerCount > 0;

  return (
    <>
      <TopBar
        title="Αναφορές"
        actions={
          <button
            onClick={() => {
              void load();
            }}
            className="luxury-btn-secondary text-xs px-4 py-2"
          >
            <RefreshCw size={13} />
            Ανανέωση
          </button>
        }
      />

      <div className="p-4 sm:p-6 space-y-6 animate-fade-in">
        <div className="luxury-card">
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Calendar size={14} className="text-charcoal-400" />
              <p className="text-sm font-medium text-charcoal-800">
                Περίοδος αναφοράς
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <FormField label="Από">
                <Input
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </FormField>

              <FormField label="Έως">
                <Input
                  type="date"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                />
              </FormField>
            </div>

            <div className="flex flex-wrap gap-2">
              <PresetButton
                label="7 ημέρες"
                active={isPresetActive(7)}
                onClick={() => setPreset(7)}
              />
              <PresetButton
                label="30 ημέρες"
                active={isPresetActive(30)}
                onClick={() => setPreset(30)}
              />
              <PresetButton
                label="90 ημέρες"
                active={isPresetActive(90)}
                onClick={() => setPreset(90)}
              />
            </div>

            <div className="pt-2 border-t border-charcoal-100">
              <p className="text-xs text-charcoal-500">
                {formatDateLabel(from)} → {formatDateLabel(to)} · {selectedDays} ημέρες
              </p>
            </div>
          </div>
        </div>

        {isRangeInvalid ? (
          <div className="luxury-card">
            <EmptyState
              icon={<XCircle size={18} />}
              title="Μη έγκυρη περίοδος"
              description="Η ημερομηνία έναρξης δεν μπορεί να είναι μετά την ημερομηνία λήξης."
            />
          </div>
        ) : loading ? (
          <PageLoader />
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
              <MetricCard
                icon={<CreditCard size={18} className="text-charcoal-600" />}
                label="Εισπραγμένα"
                value={`€${collectedRevenue.toFixed(2)}`}
                sub={`${paidPayments.length} πληρωμένες συναλλαγές`}
              />

              <MetricCard
                icon={<Wallet size={18} className="text-charcoal-600" />}
                label="Αξία ραντεβού"
                value={`€${bookedValue.toFixed(2)}`}
                sub={`${validAppointments.length} έγκυρα ραντεβού`}
              />

              <MetricCard
                icon={<Calendar size={18} className="text-charcoal-600" />}
                label="Ραντεβού"
                value={appointments.length}
                sub={`${completedAppts} ολοκληρωμένα`}
              />

              <MetricCard
                icon={<Users size={18} className="text-charcoal-600" />}
                label="Ενεργοί πελάτες"
                value={activeCustomersInPeriod}
                sub={`Σύνολο πελατών: ${customerCount}`}
              />
            </div>

            {!hasAnyData ? (
              <div className="luxury-card">
                <EmptyState
                  icon={<BarChart3 size={20} />}
                  title="Δεν υπάρχουν δεδομένα"
                  description="Δεν βρέθηκαν πληρωμές ή ραντεβού για την επιλεγμένη περίοδο."
                />
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
                  <div className="luxury-card">
                    <div className="flex items-center gap-2 mb-4">
                      <CreditCard size={16} className="text-charcoal-500" />
                      <h3 className="text-sm font-semibold text-charcoal-800">
                        Πληρωμές
                      </h3>
                    </div>

                    <p className="text-3xl font-semibold text-charcoal-900 mb-4">
                      €{collectedRevenue.toFixed(2)}
                    </p>

                    <StatRow
                      label="Πληρωμένες συναλλαγές"
                      value={paidPayments.length}
                    />
                    <StatRow
                      label="Εκκρεμείς / μη πληρωμένες"
                      value={pendingPayments.length}
                    />
                    <StatRow
                      label="Μέσο ποσό ανά πληρωμή"
                      value={`€${avgCollectedPerPayment.toFixed(2)}`}
                    />

                    <div className="mt-4 pt-4 border-t border-charcoal-100">
                      <p className="text-xs font-medium text-charcoal-500 uppercase tracking-wider mb-3">
                        Ανάλυση ανά μέθοδο
                      </p>

                      {paymentMethods.length === 0 ? (
                        <p className="text-xs text-charcoal-400">
                          Δεν υπάρχουν πληρωμένες συναλλαγές.
                        </p>
                      ) : (
                        paymentMethods.map(([method, amount]) => (
                          <StatRow
                            key={method}
                            label={formatMethodLabel(method)}
                            value={`€${amount.toFixed(2)}`}
                          />
                        ))
                      )}
                    </div>
                  </div>

                  <div className="luxury-card">
                    <div className="flex items-center gap-2 mb-4">
                      <Clock3 size={16} className="text-charcoal-500" />
                      <h3 className="text-sm font-semibold text-charcoal-800">
                        Ραντεβού
                      </h3>
                    </div>

                    <p className="text-3xl font-semibold text-charcoal-900 mb-4">
                      {appointments.length}
                    </p>

                    <StatRow label="Ολοκληρωμένα" value={completedAppts} />
                    <StatRow label="Σε αναμονή" value={pendingAppts} />
                    <StatRow label="Επιβεβαιωμένα" value={confirmedAppts} />
                    <StatRow label="Σε εξέλιξη / άφιξη" value={inServiceAppts} />
                    <StatRow
                      label="Ακυρώσεις + no show"
                      value={canceledAppts + noShowAppts}
                      sub={`${cancellationRate.toFixed(1)}% του συνόλου`}
                    />
                  </div>

                  <div className="luxury-card">
                    <div className="flex items-center gap-2 mb-4">
                      <TrendingUp size={16} className="text-charcoal-500" />
                      <h3 className="text-sm font-semibold text-charcoal-800">
                        Σύνοψη
                      </h3>
                    </div>

                    <StatRow label="Σύνολο πελατών" value={customerCount} />
                    <StatRow
                      label="Πελάτες με ραντεβού στην περίοδο"
                      value={activeCustomersInPeriod}
                    />
                    <StatRow
                      label="Μέση αξία ανά ραντεβού"
                      value={`€${avgPerAppointment.toFixed(2)}`}
                    />
                    <StatRow
                      label="Ποσοστό ολοκλήρωσης"
                      value={`${completionRate.toFixed(1)}%`}
                    />

                    <div className="mt-4 pt-4 border-t border-charcoal-100">
                      <p className="text-xs font-medium text-charcoal-500 uppercase tracking-wider mb-3">
                        Πιο φορτωμένες ημέρες
                      </p>

                      {topDays.length === 0 ? (
                        <p className="text-xs text-charcoal-400">Δεν υπάρχουν δεδομένα.</p>
                      ) : (
                        topDays.map(([date, count]) => (
                          <div
                            key={date}
                            className="flex items-center justify-between py-1.5 gap-3"
                          >
                            <span className="text-xs text-charcoal-600">
                              {formatDayLabel(date)}
                            </span>

                            <div className="flex items-center gap-2 min-w-[110px] justify-end">
                              <div className="w-16 h-1.5 bg-charcoal-100 rounded-full overflow-hidden">
                                <div
                                  className="h-full bg-charcoal-700 rounded-full"
                                  style={{
                                    width: `${(count / topDayCount) * 100}%`,
                                  }}
                                />
                              </div>

                              <span className="text-xs font-medium text-charcoal-700 w-5 text-right">
                                {count}
                              </span>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>

                <div className="luxury-card">
                  <div className="flex items-center gap-2 mb-2">
                    <BarChart3 size={16} className="text-charcoal-500" />
                    <h3 className="text-sm font-semibold text-charcoal-800">
                      Κατανομή κατάστασης ραντεβού
                    </h3>
                  </div>

                  <p className="text-xs text-charcoal-400 mb-4">
                    Κατανομή των ραντεβού ανά κατάσταση για την επιλεγμένη περίοδο.
                  </p>

                  <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-7 gap-3">
                    {(
                      [
                        'pending',
                        'confirmed',
                        'arrived',
                        'in_service',
                        'completed',
                        'canceled',
                        'no_show',
                      ] as const
                    ).map((status) => {
                      const count = appointments.filter((a) => a.status === status).length;
                      const pct =
                        appointments.length > 0
                          ? (count / appointments.length) * 100
                          : 0;

                      return (
                        <div
                          key={status}
                          className="text-center p-3 rounded-xl bg-cream-50"
                        >
                          <p className="text-xl font-semibold text-charcoal-900">
                            {count}
                          </p>
                          <p className="text-xs text-charcoal-500 mt-0.5">
                            {STATUS_LABELS[status]}
                          </p>
                          <p className="text-xs text-charcoal-400 mt-0.5">
                            {pct.toFixed(0)}%
                          </p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}