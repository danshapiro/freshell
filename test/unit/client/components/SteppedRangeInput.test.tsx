import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { SteppedRangeInput } from '@/components/settings/settings-controls'

// Small fixture with a dual-rate gap (200 -> 225) mirroring the UI-scale options.
const VALUES = [75, 80, 200, 225, 250]

function renderControl({ value = 80, onChange = vi.fn() }: { value?: number; onChange?: ReturnType<typeof vi.fn> } = {}) {
  render(
    <SteppedRangeInput
      value={value}
      values={VALUES}
      onChange={onChange}
      aria-label="Test scale"
      unit="%"
    />
  )
  return {
    onChange,
    slider: screen.getByRole('slider', { name: 'Test scale' }) as HTMLInputElement,
    spin: screen.getByRole('spinbutton', { name: 'Test scale' }) as HTMLInputElement,
  }
}

afterEach(() => {
  cleanup()
})

describe('SteppedRangeInput', () => {
  describe('slider element', () => {
    it('exposes an index-based range with aria-valuetext announcing the display value', () => {
      const { slider } = renderControl({ value: 80 })

      expect(slider.getAttribute('min')).toBe('0')
      expect(slider.getAttribute('max')).toBe('4')
      expect(slider.getAttribute('step')).toBe('1')
      expect(slider.value).toBe('1')
      expect(slider.getAttribute('aria-valuetext')).toBe('80%')
    })

    it('renders the nearest stop index for an off-list value', () => {
      const { slider } = renderControl({ value: 220 })

      // |220 - 200| = 20 vs |220 - 225| = 5 -> index 3
      expect(slider.value).toBe('3')
    })

    it('resolves nearest-stop ties to the lower index', () => {
      const { slider } = renderControl({ value: 77.5 })

      // Equidistant between 75 (index 0) and 80 (index 1) -> lower index wins.
      expect(slider.value).toBe('0')
    })
  })

  describe('spinbutton element', () => {
    it('shows the committed value exactly, including off-list values', () => {
      const { spin, slider } = renderControl({ value: 137 })

      expect(spin.value).toBe('137')
      // Slider snaps its rendering to the nearest stop without touching the value.
      expect(slider.value).toBe('1')
      expect(slider.getAttribute('aria-valuetext')).toBe('137%')
    })
  })

  describe('pointer drag', () => {
    it('defers commit until pointer-up while live-previewing the pending stop', () => {
      const { onChange, slider, spin } = renderControl({ value: 80 })

      fireEvent.pointerDown(slider)
      fireEvent.change(slider, { target: { value: '3' } })

      expect(onChange).not.toHaveBeenCalled()
      expect(spin.value).toBe('225')
      expect(slider.getAttribute('aria-valuetext')).toBe('225%')

      fireEvent.pointerUp(slider)

      expect(onChange).toHaveBeenCalledTimes(1)
      expect(onChange).toHaveBeenCalledWith(225)
    })
  })

  describe('keyboard changes', () => {
    it('commits immediately when the slider changes without an active pointer', () => {
      const { onChange, slider } = renderControl({ value: 80 })

      fireEvent.change(slider, { target: { value: '2' } })

      expect(onChange).toHaveBeenCalledTimes(1)
      expect(onChange).toHaveBeenCalledWith(200)
    })
  })

  describe('numeric input commits', () => {
    it('clamps below-range input up to the minimum on blur', () => {
      const { onChange, spin } = renderControl({ value: 80 })

      fireEvent.change(spin, { target: { value: '50' } })
      fireEvent.blur(spin)

      expect(onChange).toHaveBeenCalledTimes(1)
      expect(onChange).toHaveBeenCalledWith(75)
    })

    it('clamps above-range input down to the maximum on Enter', () => {
      const { onChange, spin } = renderControl({ value: 80 })

      fireEvent.change(spin, { target: { value: '999' } })
      fireEvent.keyDown(spin, { key: 'Enter' })

      expect(onChange).toHaveBeenCalledTimes(1)
      expect(onChange).toHaveBeenCalledWith(250)
    })

    it('commits typed off-list values without snapping to a stop', () => {
      const { onChange, spin } = renderControl({ value: 80 })

      fireEvent.change(spin, { target: { value: '137' } })
      fireEvent.blur(spin)

      expect(onChange).toHaveBeenCalledTimes(1)
      expect(onChange).toHaveBeenCalledWith(137)
    })

    it('reverts non-numeric or empty input on blur without committing', () => {
      const { onChange, spin } = renderControl({ value: 80 })

      fireEvent.change(spin, { target: { value: '' } })
      fireEvent.blur(spin)

      expect(onChange).not.toHaveBeenCalled()
      expect(spin.value).toBe('80')
    })

    it('reverts the draft on Escape without committing', () => {
      const { onChange, spin } = renderControl({ value: 80 })

      fireEvent.change(spin, { target: { value: '123' } })
      fireEvent.keyDown(spin, { key: 'Escape' })

      expect(onChange).not.toHaveBeenCalled()
      expect(spin.value).toBe('80')

      // A subsequent blur must not commit the reverted draft either.
      fireEvent.blur(spin)
      expect(onChange).not.toHaveBeenCalled()
    })

    it('does not call onChange when committing the unchanged value', () => {
      const { onChange, spin } = renderControl({ value: 80 })

      fireEvent.change(spin, { target: { value: '80' } })
      fireEvent.blur(spin)

      expect(onChange).not.toHaveBeenCalled()
    })
  })
})
