import { describe, expect, it } from 'vitest';
import { Icon } from '../src/views/components/icons';

describe('jsx smoke', () => {
  it('icon', () => {
    expect(String(<Icon name="bolt" />).startsWith('<svg')).toBe(true);
  });
  it('script', () => {
    expect(String(<script dangerouslySetInnerHTML={{ __html: 'x' }} />)).toBe('<script>x</script>');
  });
});
