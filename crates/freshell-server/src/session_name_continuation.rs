//! Admission of a known session and one-time name inheritance for an
//! explicit internal continuation. Neither operation creates redirects
//! between durable identities or changes an existing target's saved name.

use super::*;

fn durable_provider(target: &SessionNameRef) -> Result<NamedProvider, NameError> {
    match target {
        SessionNameRef::Session {
            provider,
            session_id,
        } if !session_id.trim().is_empty() => Ok(*provider),
        _ => Err(NameError::InvalidName(
            "a durable nonempty session target is required".into(),
        )),
    }
}

pub(super) fn ensure_session(
    document: &mut StoredDocument,
    target: SessionNameRef,
    cwd: Option<String>,
) -> Result<Decision<SessionNameUpdate>, NameError> {
    let provider = durable_provider(&target)?;
    let key = name_ref_key(&target);
    if document.record_at(&key).is_some() {
        return Ok(Decision::Read(read_update(document, &key)));
    }
    let revision = document.allocate_revision()?;
    document.records.insert(
        key.clone(),
        SessionNameRecord {
            name_ref: target,
            name: directory_fallback_name(cwd.as_deref(), &provider),
            source: NameSource::Directory,
            revision,
            manual_revision: None,
            renamed_at: None,
            legacy_origin: None,
        },
    );
    Ok(commit_decision(
        document,
        &key,
        Some(NameChangeEvent::new(
            NameChangeCause::EnsureSession,
            None,
            None,
        )),
    ))
}

pub(super) fn continue_session(
    document: &mut StoredDocument,
    now_ms: i64,
    source: SessionNameRef,
    target: SessionNameRef,
) -> Result<Decision<Option<SessionNameUpdate>>, NameError> {
    let provider = durable_provider(&target)?;
    let key = name_ref_key(&target);
    if document.record_at(&key).is_some() {
        return Ok(Decision::Read(Some(read_update(document, &key))));
    }
    let (resolved, _) = document.resolve_ref(&source);
    if let SessionNameRef::Session {
        provider: source_provider,
        ..
    } = &resolved
    {
        if *source_provider != provider {
            return Err(NameError::IdentityAmbiguous(
                "an internal continuation must keep its provider".into(),
            ));
        }
    }
    let source_key = name_ref_key(&resolved);
    let Some(mut record) = document.record_at(&source_key).cloned() else {
        return Ok(Decision::Read(None));
    };
    record.name_ref = target;
    record.revision = document.allocate_revision()?;
    document.records.insert(key.clone(), record.clone());
    // A continuation keeps the source's generation history (including an
    // exhausted series); it is not a new opportunity to rename a session.
    if let Some(mut series) = document.generation.get(&source_key).cloned() {
        // The worker's live request belongs only to the source key. The
        // copied child must settle that inherited start as interrupted,
        // retaining its bounded accounting instead of waiting forever.
        if series.status == GenerationStatus::InFlight {
            session_name_generation_series::settle_consumed_start(&mut series, now_ms);
        }
        document.generation.insert(key.clone(), series);
    }
    if source_is_writable(record.source) {
        reset_native_series(document, &key, &record);
    }
    let change = NameChangeEvent::new(NameChangeCause::InternalContinuation, None, None)
        .with_from_ref(&source_key);
    Ok(Decision::Write {
        value: Some(
            update_after_commit(document, &key, true, RedirectScope::None)
                .expect("the inserted child resolves"),
        ),
        publish: vec![PublishSpec::changed(key, change)],
    })
}
