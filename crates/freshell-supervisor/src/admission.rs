use freshell_runtime_protocol::RuntimeLimits;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AdmissionBudget {
    pub cpu_milli: u64,
    pub memory_bytes: u64,
    pub pids_max: u64,
}

impl AdmissionBudget {
    pub const fn new(cpu_milli: u64, memory_bytes: u64, pids_max: u64) -> Self {
        Self {
            cpu_milli,
            memory_bytes,
            pids_max,
        }
    }

    pub fn validate(self) -> Result<Self, &'static str> {
        if self.cpu_milli == 0 || self.memory_bytes == 0 || self.pids_max == 0 {
            return Err("admission budget values must be nonzero");
        }
        Ok(self)
    }

    pub fn admits(self, used: ReservationTotals, requested: RuntimeLimits) -> bool {
        used.cpu_milli.saturating_add(requested.cpu_milli) <= self.cpu_milli
            && used.memory_bytes.saturating_add(requested.memory_bytes) <= self.memory_bytes
            && used.pids_max.saturating_add(requested.pids_max) <= self.pids_max
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AdmissionPolicy {
    pub installation: AdmissionBudget,
    pub project: AdmissionBudget,
}

impl Default for AdmissionPolicy {
    fn default() -> Self {
        Self {
            installation: AdmissionBudget::new(64_000, 128 * 1024 * 1024 * 1024, 32_768),
            project: AdmissionBudget::new(16_000, 32 * 1024 * 1024 * 1024, 8_192),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ReservationTotals {
    pub cpu_milli: u64,
    pub memory_bytes: u64,
    pub pids_max: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sums_reservations_not_sampled_usage() {
        let budget = AdmissionBudget::new(2_000, 4_000, 10);
        let used = ReservationTotals {
            cpu_milli: 1_500,
            memory_bytes: 2_000,
            pids_max: 5,
        };
        assert!(budget.admits(
            used,
            RuntimeLimits {
                cpu_milli: 500,
                memory_bytes: 2_000,
                swap_bytes: 0,
                pids_max: 5
            }
        ));
        assert!(!budget.admits(
            used,
            RuntimeLimits {
                cpu_milli: 501,
                memory_bytes: 1,
                swap_bytes: 0,
                pids_max: 1
            }
        ));
    }
}
