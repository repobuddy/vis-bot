/**
 * Unit tests for src/wait.ts
 */
import { describe, it, expect } from 'vitest'
import { wait } from '../src/wait.js'

describe('wait.ts', () => {
	it('Throws an invalid number', async () => {
		const input = Number.parseInt('foo', 10)

		expect(Number.isNaN(input)).toBe(true)

		await expect(wait(input)).rejects.toThrow('milliseconds is not a number')
	})

	it('Waits with a valid number', async () => {
		const start = new Date()
		await wait(500)
		const end = new Date()

		const delta = Math.abs(end.getTime() - start.getTime())

		expect(delta).toBeGreaterThan(450)
	})
})
