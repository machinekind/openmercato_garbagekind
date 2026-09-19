/** @jest-environment jsdom */
import * as React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { apiCallOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import DigitalTwinViewer from '../components/DigitalTwinViewer'
import manifest from '../assets/room.manifest.json'

jest.mock('@open-mercato/shared/lib/i18n/context', () => ({ useT: () => (key: string, fallback?: string) => fallback ?? key }))
jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({ apiCallOrThrow: jest.fn() }))
jest.mock('@open-mercato/ui/backend/Page', () => ({
  Page: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  PageBody: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}))
jest.mock('@open-mercato/ui/backend/detail', () => ({
  LoadingMessage: ({ label }: { label: string }) => <p>{label}</p>,
  ErrorMessage: ({ label, action }: { label: string; action: React.ReactNode }) => <div role="alert">{label}{action}</div>,
}))

const mockApi = jest.mocked(apiCallOrThrow)
const engine = { dispose: jest.fn(), fit: jest.fn(), setView: jest.fn(), setLayer: jest.fn(), select: jest.fn() }
const create = jest.fn()

beforeEach(() => {
  jest.clearAllMocks()
  mockApi.mockImplementation(async (url) => ({ result: String(url).endsWith('/room') ? manifest : new ArrayBuffer(8) }) as Awaited<ReturnType<typeof apiCallOrThrow>>)
  create.mockResolvedValue(engine)
  window.DigitalTwinRenderer = { create }
})

test('floor plan and layers control the engine, and unmount releases it', async () => {
  const result = render(<DigitalTwinViewer />)
  await waitFor(() => expect(screen.getByText('digital_twins.top')).toBeEnabled())
  fireEvent.click(screen.getByText('digital_twins.top'))
  expect(engine.setView).toHaveBeenCalledWith('top')
  fireEvent.click(screen.getByRole('checkbox', { name: 'Sufit 1' }))
  expect(engine.setLayer).toHaveBeenCalledWith('roof', true)
  result.unmount()
  expect(engine.dispose).toHaveBeenCalledTimes(1)
})

test('failed requests expose a retry and recover without mounting a broken renderer', async () => {
  mockApi.mockRejectedValueOnce(new Error('offline'))
  render(<DigitalTwinViewer />)
  await screen.findByRole('alert')
  expect(create).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('digital_twins.retry'))
  await waitFor(() => expect(screen.getByText('digital_twins.fit')).toBeEnabled())
  expect(screen.queryByRole('alert')).toBeNull()
})

test('a renderer resolving after navigation is disposed instead of leaking WebGL', async () => {
  let finish: ((value: typeof engine) => void) | undefined
  create.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
  const result = render(<DigitalTwinViewer />)
  await waitFor(() => expect(create).toHaveBeenCalled())
  result.unmount()
  await act(async () => { finish?.(engine) })
  expect(engine.dispose).toHaveBeenCalledTimes(1)
})
