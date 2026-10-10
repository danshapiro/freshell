//! Windows placeholder until Task 6 (which deletes it): a unit whose
//! placement only adds the tag and whose kill finds no members, so a stop
//! kills exactly its pinned roots. Nothing executes on Windows before Task
//! 6; only the cross-target check compiles it.

use std::io;
use std::sync::Arc;

use super::{Backend, BackendKind, Capability, KillSummary, MemberList, UnitBackend};
use crate::unit::{MemberRole, Placement};
use crate::{BoxFuture, UnitId, UNIT_ENV};

pub(crate) struct RootsBackend;

pub(crate) struct RootsUnit(String);

impl RootsUnit {
    pub(crate) fn new(id: &UnitId) -> Self {
        Self(id.as_str().to_string())
    }
}

impl Backend for RootsBackend {
    fn capability(&self) -> Capability {
        Capability {
            kind: BackendKind::WindowsJob,
            full: false,
            reason: Some("job objects arrive in Task 6".into()),
        }
    }

    fn create(&self, id: &UnitId) -> io::Result<Arc<dyn UnitBackend>> {
        Ok(Arc::new(RootsUnit::new(id)))
    }

    fn reopen(&self, id: &UnitId) -> io::Result<Arc<dyn UnitBackend>> {
        self.create(id)
    }
}

impl UnitBackend for RootsUnit {
    fn placement(&self, _role: MemberRole, _seq: u32) -> io::Result<Placement> {
        Ok(Placement {
            wrapper: None,
            env: vec![(UNIT_ENV.to_string(), self.0.clone())],
        })
    }

    fn kill_all(
        self: Arc<Self>,
        _roots: Vec<(u32, u64)>,
    ) -> BoxFuture<'static, io::Result<KillSummary>> {
        Box::pin(async { Ok(KillSummary::default()) })
    }

    fn members(&self, _roots: &[(u32, u64)]) -> io::Result<MemberList> {
        Ok(MemberList::default())
    }

    fn confirm_placement(&self, _pid: u32, _roots: &[(u32, u64)]) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "placement confirmation arrives with job objects (Task 6)",
        ))
    }

    fn wait_empty(&self) -> Option<BoxFuture<'static, io::Result<()>>> {
        None
    }

    fn remove(&self, _emptied: bool) -> io::Result<()> {
        Ok(())
    }
}
