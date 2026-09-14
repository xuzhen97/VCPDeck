use crate::media::{InputEvent, MediaError, PointerCoalescer, PointerSample};
use crate::session::AttachmentRole;

#[derive(Debug, Default)]
pub struct InputRouter {
    frozen: bool,
    layout_generation: u64,
    pointer: PointerCoalescer,
}

impl InputRouter {
    pub const fn new() -> Self {
        Self {
            frozen: false,
            layout_generation: 0,
            pointer: PointerCoalescer::new(),
        }
    }

    pub fn freeze(&mut self) {
        self.frozen = true;
    }

    pub fn set_layout_generation(&mut self, generation: u64) {
        self.layout_generation = generation;
        self.freeze();
    }

    pub fn layout_generation(&self) -> u64 {
        self.layout_generation
    }

    pub fn resume(&mut self, generation: u64) {
        if generation == self.layout_generation {
            self.frozen = false;
        }
    }

    pub fn release_all(&mut self) {
        self.frozen = true;
        let _ = self.pointer.take_latest();
    }

    pub fn accept(&mut self, role: AttachmentRole, event: InputEvent) -> Result<(), MediaError> {
        if self.frozen {
            return Err(MediaError::InputFrozen);
        }
        if role != AttachmentRole::Operator {
            return Err(MediaError::ViewerInputDenied);
        }
        if let InputEvent::PointerMove { x, y } = event {
            self.pointer.push(PointerSample { x, y });
        }
        Ok(())
    }

    pub fn accept_pointer(
        &mut self,
        role: AttachmentRole,
        layout_generation: u64,
        sample: PointerSample,
    ) -> Result<(), MediaError> {
        if self.frozen {
            return Err(MediaError::InputFrozen);
        }
        if role != AttachmentRole::Operator {
            return Err(MediaError::ViewerInputDenied);
        }
        if layout_generation != self.layout_generation {
            return Err(MediaError::InputFrozen);
        }
        self.pointer.push(sample);
        Ok(())
    }

    pub fn next_pointer(&mut self) -> Option<PointerSample> {
        self.pointer.take_latest()
    }

    pub fn pointer_received(&self) -> usize {
        self.pointer.received()
    }
}
